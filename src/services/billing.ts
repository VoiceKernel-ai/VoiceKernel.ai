import { queryOne } from '../db';
import { logger } from '../logger';
import { emitEvent } from './webhooks';
import { updateOrg, type OrganizationRow } from './org';

/**
 * Budget tracking and the no-dead-line policy.
 *
 * The commercial promise is that hitting a budget never drops a live call and
 * never stops answering inbound - only outbound campaigns pause. That is a
 * safety property, so it is enforced here rather than left to the UI: the only
 * thing a budget breach can block is *starting new outbound work*.
 *
 * What this module deliberately does not do is take payment. Collecting a card
 * would put this service in PCI scope, and no processor is configured. The
 * chosen payment method is recorded; activating it is a separate integration.
 */

export type PaymentMethod = 'card' | 'invoice' | 'direct_debit';

export interface BillingSettings {
  monthlyBudget: number | null;
  currency: string;
  alertThresholds: number[];
  requireApprovalAtLimit: boolean;
  billingEntity: string | null;
  costAllocationTag: string | null;
  paymentMethod: PaymentMethod | null;
  activatedAt: string | null;
  /** Thresholds already notified this period, so alerts fire once each. */
  notified: number[];
  notifiedPeriod: string | null;
}

const DEFAULTS: BillingSettings = {
  monthlyBudget: null,
  currency: 'USD',
  alertThresholds: [0.5, 0.8, 1.0],
  requireApprovalAtLimit: true,
  billingEntity: null,
  costAllocationTag: null,
  paymentMethod: null,
  activatedAt: null,
  notified: [],
  notifiedPeriod: null,
};

export function billingSettings(org: OrganizationRow): BillingSettings {
  return { ...DEFAULTS, ...((org.settings.billing ?? {}) as Partial<BillingSettings>) };
}

/** Current calendar month, used to reset alert bookkeeping. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface BudgetStatus {
  period: string;
  budget: number | null;
  spend: number;
  minutes: number;
  calls: number;
  /** Fraction of budget consumed; null when no budget is set. */
  used: number | null;
  remaining: number | null;
  /** Straight-line projection to month end from spend so far. */
  projected: number | null;
  overBudget: boolean;
  /** Outbound campaigns paused because the budget is exhausted. */
  outboundPaused: boolean;
  thresholdsCrossed: number[];
  note: string;
}

export async function budgetStatus(org: OrganizationRow): Promise<BudgetStatus> {
  const settings = billingSettings(org);
  const period = currentPeriod();

  const row = await queryOne<{ spend: string | null; minutes: string | null; calls: string }>(
    `SELECT SUM(cost)::text                       AS spend,
            (SUM(duration_seconds) / 60.0)::text  AS minutes,
            COUNT(*)::text                        AS calls
       FROM calls
      WHERE org_id = $1 AND created_at >= date_trunc('month', now())`,
    [org.id],
  );

  const spend = Number.parseFloat(row?.spend ?? '0') || 0;
  const minutes = Number.parseFloat(row?.minutes ?? '0') || 0;
  const budget = settings.monthlyBudget;
  const used = budget && budget > 0 ? spend / budget : null;

  // Straight-line to month end. Crude, and labelled as such rather than
  // dressed up as a forecast.
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = dayOfMonth > 0 ? (spend / dayOfMonth) * daysInMonth : null;

  const overBudget = used !== null && used >= 1;

  return {
    period,
    budget,
    spend: Number(spend.toFixed(4)),
    minutes: Number(minutes.toFixed(2)),
    calls: Number.parseInt(row?.calls ?? '0', 10),
    used: used === null ? null : Number(used.toFixed(4)),
    remaining: budget === null ? null : Number(Math.max(0, budget - spend).toFixed(4)),
    projected: projected === null ? null : Number(projected.toFixed(2)),
    overBudget,
    outboundPaused: overBudget && settings.requireApprovalAtLimit,
    thresholdsCrossed: settings.alertThresholds.filter((t) => used !== null && used >= t),
    note:
      budget === null
        ? 'No monthly budget is set, so nothing is capped and no alerts fire.'
        : overBudget
          ? 'Budget reached. Live calls continue and inbound keeps answering; only new outbound campaigns are paused until an admin raises the budget.'
          : 'Within budget.',
  };
}

/**
 * Emits a `billing.threshold` event the first time each threshold is crossed
 * in a period, so a customer's own systems can react.
 *
 * The already-notified list is persisted rather than held in memory: this runs
 * per request, and an in-memory guard would re-alert after every deploy.
 */
export async function checkBudgetAlerts(org: OrganizationRow): Promise<number[]> {
  const settings = billingSettings(org);
  if (!settings.monthlyBudget) return [];

  const status = await budgetStatus(org);
  const period = currentPeriod();

  // A new month resets the ledger.
  const alreadyNotified = settings.notifiedPeriod === period ? settings.notified : [];
  const newlyCrossed = status.thresholdsCrossed.filter((t) => !alreadyNotified.includes(t));
  if (!newlyCrossed.length) return [];

  for (const threshold of newlyCrossed) {
    await emitEvent({
      orgId: org.id,
      type: 'billing.threshold',
      resourceKind: 'organization',
      resourceId: org.id,
      payload: {
        threshold,
        period,
        budget: status.budget,
        spend: status.spend,
        used: status.used,
        outboundPaused: threshold >= 1 && settings.requireApprovalAtLimit,
        message:
          threshold >= 1
            ? 'Monthly budget reached. Inbound and live calls are unaffected; new outbound campaigns are paused until the budget is raised.'
            : `Monthly budget ${Math.round(threshold * 100)}% consumed.`,
      },
    }).catch((err) => logger.error({ err, orgId: org.id }, 'failed to emit budget alert'));
  }

  await updateOrg(org.id, {
    settings: {
      billing: {
        ...settings,
        notified: [...alreadyNotified, ...newlyCrossed],
        notifiedPeriod: period,
      },
    },
  });

  return newlyCrossed;
}

export async function updateBilling(
  org: OrganizationRow,
  patch: Partial<BillingSettings>,
): Promise<OrganizationRow> {
  const current = billingSettings(org);
  const next: BillingSettings = { ...current, ...patch };

  // Raising the budget re-arms the alerts that were already sent, so the
  // customer is told again when they reach the new ceiling.
  if (patch.monthlyBudget !== undefined && patch.monthlyBudget !== current.monthlyBudget) {
    next.notified = [];
    next.notifiedPeriod = currentPeriod();
  }

  // The updated row is returned, not the caller's stale one - the route needs
  // it to report a budget status that reflects the change it just made.
  return updateOrg(org.id, { settings: { billing: next } });
}

/**
 * The estimate behind the budget slider.
 *
 * Uses the org's own measured blended rate when there is enough history, and
 * says which it used - a pilot with no calls yet gets the list rate and is told
 * so, rather than a confident number derived from nothing.
 */
export async function estimateMinutes(
  org: OrganizationRow,
  budget: number,
): Promise<{ minutes: number; ratePerMinute: number; basis: string }> {
  const row = await queryOne<{ minutes: string | null; cost: string | null }>(
    `SELECT (SUM(duration_seconds) / 60.0)::text AS minutes, SUM(cost)::text AS cost
       FROM calls
      WHERE org_id = $1 AND created_at > now() - interval '90 days'
        AND duration_seconds IS NOT NULL AND cost IS NOT NULL`,
    [org.id],
  );

  const minutes = Number.parseFloat(row?.minutes ?? '0') || 0;
  const cost = Number.parseFloat(row?.cost ?? '0') || 0;

  if (minutes >= 60 && cost > 0) {
    const rate = cost / minutes;
    return {
      minutes: Math.round(budget / rate),
      ratePerMinute: Number(rate.toFixed(4)),
      basis: `your measured blended rate over ${Math.round(minutes)} minutes of calls`,
    };
  }

  const listRate = 0.09;
  return {
    minutes: Math.round(budget / listRate),
    ratePerMinute: listRate,
    basis: 'the list rate - not enough of your own call history to measure a blended rate yet',
  };
}
