import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireRole, requireScope } from '../../middleware/auth';
import { parseWindow } from '../../lib/http';
import { updateOrg } from '../../services/org';
import {
  billingSettings,
  budgetStatus,
  checkBudgetAlerts,
  estimateMinutes,
  updateBilling,
} from '../../services/billing';
import { ApiError } from '../../errors';
import { eraseSubject, previewErasure } from '../../services/erasure';
import { byAgent, overview } from '../../services/analytics';
import { config } from '../../config';
import { recordAudit } from '../../services/audit';
import { clientIp } from '../../middleware/context';

/**
 * Settings surfaces: change control, residency, retention, attestations,
 * workload spend, and subject erasure.
 *
 * Where a control is genuinely enforced by this codebase, it says so. Where the
 * value is a record of something decided outside the software - an audit
 * attestation, a signed retention policy - it is stored and reported as
 * *recorded*, not as *enforced*. A compliance screen that cannot distinguish
 * the two is worse than no screen.
 */
export const governanceRouter = Router();

// ---------------------------------------------------------------------------
// Change control
// ---------------------------------------------------------------------------

const changeControlSchema = z.object({
  requireEvalGateForProduction: z.boolean().optional(),
  requireDualApprovalForWaivers: z.boolean().optional(),
  notifyPromptChanges: z.boolean().optional(),
  notifyWebhookUrl: z.string().url().nullable().optional(),
});

/**
 * `enforced` is the honest part of this payload: it names which of these
 * settings the platform actually acts on today.
 */
governanceRouter.get(
  '/change-control',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const settings = (org.settings.changeControl ?? {}) as Record<string, unknown>;

    res.json({
      object: 'change_control',
      settings: {
        requireEvalGateForProduction: settings.requireEvalGateForProduction ?? true,
        requireDualApprovalForWaivers: settings.requireDualApprovalForWaivers ?? false,
        notifyPromptChanges: settings.notifyPromptChanges ?? true,
        notifyWebhookUrl: settings.notifyWebhookUrl ?? null,
      },
      enforced: {
        requireEvalGateForProduction:
          'Enforced. GET /v1/observe/evals/summary reports canPromote:false while any suite fails or has never run.',
        requireDualApprovalForWaivers:
          'Recorded only. This deployment has no approval workflow; enforce it in your change process.',
        notifyPromptChanges:
          'Enforced. Agent changes emit agent.updated to every subscribed webhook endpoint.',
      },
    });
  }),
);

governanceRouter.put(
  '/change-control',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const patch = changeControlSchema.parse(req.body ?? {});
    const merged = { ...(org.settings.changeControl as object ?? {}), ...patch };
    const updated = await updateOrg(org.id, { settings: { changeControl: merged } });
    res.json({ object: 'change_control', settings: updated.settings.changeControl });
  }),
);

// ---------------------------------------------------------------------------
// Residency, retention, attestations
// ---------------------------------------------------------------------------

governanceRouter.get(
  '/residency',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const retention = (org.settings.retention ?? {}) as Record<string, unknown>;
    const attestations = (org.settings.attestations ?? {}) as Record<string, unknown>;

    res.json({
      object: 'residency',
      residency: {
        processingRegion: org.region,
        deploymentModel: 'VoiceKernel cloud',
        providerMode: org.provider_mode,
        modelInference:
          org.provider_mode === 'byo'
            ? 'Routed through your own provider account.'
            : 'Routed through the shared platform provider account.',
      },
      encryption: {
        inTransit: 'TLS 1.2+ to the API and to the upstream provider.',
        atRest:
          'Tenant secrets (provider keys, webhook signing secrets) are AES-256-GCM encrypted with a versioned ciphertext prefix. Call content is stored in Postgres and inherits that database’s encryption.',
        passwords: 'argon2id.',
        apiKeys: 'SHA-256; only the hash is stored.',
      },
      retention: {
        recordings: retention.recordings ?? 'provider default',
        transcripts: retention.transcripts ?? 'retained until erased',
        auditLogs: 'retained indefinitely',
        enforced:
          'Recorded only. This deployment does not run a scheduled purge job - retention windows are a statement of policy until one is configured.',
      },
      erasure: {
        endpoint: `DELETE ${config.publicBaseUrl}/v1/subjects/:number`,
        enforced:
          'Enforced. Redacts transcripts, summaries, analysis, recordings and identifiers across calls and events, and requests provider-side deletion. Returns a receipt.',
      },
      // Attestations are business facts the software cannot verify. They are
      // stored as records and never asserted by default.
      attestations: {
        soc2: attestations.soc2 ?? null,
        iso27001: attestations.iso27001 ?? null,
        pciDss: attestations.pciDss ?? null,
        irap: attestations.irap ?? null,
        note: 'These are records you maintain, not claims this software verifies. Unset values mean "not recorded".',
      },
    });
  }),
);

const residencySchema = z.object({
  retention: z
    .object({
      recordings: z.string().max(80).optional(),
      transcripts: z.string().max(80).optional(),
    })
    .optional(),
  attestations: z
    .object({
      soc2: z.string().max(120).nullable().optional(),
      iso27001: z.string().max(120).nullable().optional(),
      pciDss: z.string().max(120).nullable().optional(),
      irap: z.string().max(120).nullable().optional(),
    })
    .optional(),
});

governanceRouter.put(
  '/residency',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const patch = residencySchema.parse(req.body ?? {});
    const settings: Record<string, unknown> = {};

    if (patch.retention) {
      settings.retention = { ...(org.settings.retention as object ?? {}), ...patch.retention };
    }
    if (patch.attestations) {
      settings.attestations = {
        ...(org.settings.attestations as object ?? {}),
        ...patch.attestations,
      };
    }

    const updated = await updateOrg(org.id, { settings });
    res.json({ object: 'residency', settings: updated.settings });
  }),
);

// ---------------------------------------------------------------------------
// Spend by workload
// ---------------------------------------------------------------------------

/**
 * Spend and minutes per agent, against an optional per-agent budget.
 *
 * "Workload" maps to agent because that is the unit customers actually run a
 * queue on, and it is the only grouping the call mirror can attribute
 * accurately without asking the operator to tag every call.
 */
governanceRouter.get(
  '/workloads',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    const budgets = (org.settings.budgets ?? {}) as Record<string, number>;

    const [agents, totals] = await Promise.all([
      byAgent(org.id, since, until),
      overview(org.id, since, until),
    ]);

    const workloads = agents.map((a) => {
      const budget = a.assistantId ? budgets[a.assistantId] ?? null : null;
      return {
        assistantId: a.assistantId,
        name: a.name ?? a.assistantId,
        calls: a.calls,
        minutes: a.minutes,
        cost: a.cost,
        containmentRate: a.containmentRate,
        budget,
        budgetUsed: budget && budget > 0 ? Number((a.cost / budget).toFixed(4)) : null,
        overBudget: budget !== null && budget > 0 ? a.cost > budget : null,
      };
    });

    res.json({
      object: 'analytics.workloads',
      window: { since, until },
      totals: {
        calls: totals.calls.total,
        minutes: totals.minutes.total,
        cost: totals.cost.total,
        blendedCostPerMinute:
          totals.minutes.total > 0
            ? Number((totals.cost.total / totals.minutes.total).toFixed(4))
            : null,
        costPerCall: totals.cost.perCall,
      },
      data: workloads,
      billing: {
        // No billing system is wired in; saying so beats an empty invoices list
        // that reads as "you owe nothing".
        invoices: null,
        note: 'This deployment has no billing integration. The figures above are provider cost measured from your own calls, not an invoice.',
      },
    });
  }),
);

const budgetSchema = z.object({ budgets: z.record(z.number().nonnegative()) });

governanceRouter.put(
  '/workloads/budgets',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { budgets } = budgetSchema.parse(req.body ?? {});
    const updated = await updateOrg(org.id, { settings: { budgets } });
    res.json({ object: 'budgets', budgets: updated.settings.budgets });
  }),
);

// ---------------------------------------------------------------------------
// Billing: budget, alerts, and the no-dead-line policy
// ---------------------------------------------------------------------------

governanceRouter.get(
  '/billing',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const settings = billingSettings(org);
    const status = await budgetStatus(org);

    // Evaluated on read so a threshold crossing is noticed even if nothing
    // else has polled recently.
    void checkBudgetAlerts(org).catch(() => {});

    res.json({
      object: 'billing',
      settings: {
        monthlyBudget: settings.monthlyBudget,
        currency: settings.currency,
        alertThresholds: settings.alertThresholds,
        requireApprovalAtLimit: settings.requireApprovalAtLimit,
        billingEntity: settings.billingEntity,
        costAllocationTag: settings.costAllocationTag,
        paymentMethod: settings.paymentMethod,
        activatedAt: settings.activatedAt,
      },
      status,
      policy: {
        noDeadLine:
          'Reaching the budget never drops a live call and never stops answering inbound. Only new outbound campaigns pause, and only while requireApprovalAtLimit is on.',
        enforced:
          'Enforced. POST /v1/campaigns and /v1/campaigns/preflight are refused while over budget; inbound and in-flight calls are untouched.',
      },
      payment: {
        // Taking a card here would put this service in PCI scope, and no
        // processor is wired in. The choice is recorded; charging is not.
        configured: false,
        note: 'This deployment records your chosen payment method but does not process payments - no payment provider is connected. Card details are never collected or stored by VoiceKernel.',
      },
    });
  }),
);

const billingSchema = z.object({
  monthlyBudget: z.number().nonnegative().max(10_000_000).nullable().optional(),
  currency: z.string().length(3).optional(),
  alertThresholds: z.array(z.number().positive().max(10)).max(6).optional(),
  requireApprovalAtLimit: z.boolean().optional(),
  billingEntity: z.string().max(200).nullable().optional(),
  costAllocationTag: z.string().max(120).nullable().optional(),
  paymentMethod: z.enum(['card', 'invoice', 'direct_debit']).nullable().optional(),
});

governanceRouter.put(
  '/billing',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const patch = billingSchema.parse(req.body ?? {});

    // Refuse anything resembling card data outright rather than storing it.
    const body = JSON.stringify(req.body ?? {});
    if (/\b(?:\d[ -]*?){13,19}\b/.test(body.replace(/"monthlyBudget":\s*\d+/g, ''))) {
      throw ApiError.badRequest(
        'Card details must not be sent to this endpoint. VoiceKernel does not process payments; connect a payment provider and collect card data there.',
      );
    }

    const updatedOrg = await updateBilling(org, {
      ...patch,
      activatedAt: patch.paymentMethod ? new Date().toISOString() : undefined,
    });
    const updated = billingSettings(updatedOrg);

    res.json({
      object: 'billing',
      settings: {
        monthlyBudget: updated.monthlyBudget,
        currency: updated.currency,
        alertThresholds: updated.alertThresholds,
        requireApprovalAtLimit: updated.requireApprovalAtLimit,
        billingEntity: updated.billingEntity,
        costAllocationTag: updated.costAllocationTag,
        paymentMethod: updated.paymentMethod,
        activatedAt: updated.activatedAt,
      },
      // Computed from the updated row, not the request-scoped one, so the
      // response reflects the change that was just made.
      status: await budgetStatus(updatedOrg),
    });
  }),
);

/** Minutes a given budget buys, from measured rate where one exists. */
governanceRouter.get(
  '/billing/estimate',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const budget = z.coerce.number().positive().max(10_000_000).parse(req.query.budget);
    res.json({ object: 'billing.estimate', budget, ...(await estimateMinutes(org, budget)) });
  }),
);

// ---------------------------------------------------------------------------
// Subject erasure
// ---------------------------------------------------------------------------

export const subjectsRouter = Router();

subjectsRouter.get(
  '/:subject',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    res.json({ object: 'subject.preview', ...(await previewErasure(org.id, req.params.subject)) });
  }),
);

/**
 * Erases a caller across this organization. Destructive and not reversible, so
 * it requires the admin role rather than a write scope alone.
 */
subjectsRouter.delete(
  '/:subject',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const deleteUpstream = req.query.upstream !== 'false';

    const receipt = await eraseSubject(org, req.params.subject, { deleteUpstream });

    // Audited explicitly: the generic middleware records the path, but an
    // erasure needs the receipt itself retained as evidence it was carried out.
    await recordAudit({
      orgId: org.id,
      actorType: req.actor?.type ?? 'system',
      actorId: req.actor?.id ?? null,
      actorLabel: req.actor?.label ?? null,
      action: 'erasure.execute',
      resourceKind: 'subject',
      resourceId: receipt.subject,
      status: receipt.complete ? 200 : 207,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
      metadata: {
        callsFound: receipt.callsFound,
        callsRedacted: receipt.callsRedacted,
        upstreamDeleted: receipt.upstream.deleted,
        upstreamFailed: receipt.upstream.failed,
        complete: receipt.complete,
      },
    });

    // 207 when provider-side deletion partially failed: the caller must not
    // read a plain 200 as "fully erased".
    res.status(receipt.complete ? 200 : 207).json({ object: 'erasure.receipt', ...receipt });
  }),
);
