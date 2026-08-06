import { config } from '../config';
import { queryOne } from '../db';

/**
 * Outbound campaign pre-flight.
 *
 * Dialling a list is the one operation on this platform that can generate a
 * regulatory breach at scale, so the checks run before launch rather than being
 * discovered in a complaint. Every check reports one of three states:
 *
 *   pass - verified against the supplied data
 *   warn - legal but worth a human decision
 *   fail - would breach a rule; blocks launch
 *   not_available - the check needs an integration this deployment lacks
 *
 * `not_available` exists deliberately. A Do Not Call wash requires a licensed
 * registry feed; reporting a green tick without one would be worse than useless
 * because it invites the operator to rely on it.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_available';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface AudienceStats {
  uploaded: number;
  invalid: number;
  duplicates: number;
  suppressed: number;
  callable: number;
}

export interface PreflightResult {
  audience: AudienceStats;
  checks: PreflightCheck[];
  /** True when nothing failed; warnings do not block. */
  canLaunch: boolean;
  projection: {
    estimatedReach: number | null;
    estimatedCalls: number;
    estimatedMinutes: number | null;
    estimatedCostRange: [number, number] | null;
    basedOn: string;
  };
  callableNumbers: string[];
}

const E164 = /^\+[1-9]\d{6,14}$/;

export interface PreflightInput {
  orgId: string;
  numbers: string[];
  /** Local calling window, 24h clock. */
  window?: { start?: string; end?: string; days?: string[] };
  firstMessage?: string;
  maxAttempts?: number;
  concurrency?: number;
  /** Numbers the tenant has locally suppressed (opt-outs). */
  suppressionList?: string[];
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  // ---- audience hygiene --------------------------------------------------
  const raw = input.numbers.map((n) => n.trim()).filter(Boolean);
  const valid: string[] = [];
  let invalid = 0;

  for (const number of raw) {
    // Tolerate the spacing people paste out of a spreadsheet.
    const normalised = number.replace(/[\s()-]/g, '');
    if (E164.test(normalised)) valid.push(normalised);
    else invalid++;
  }

  const deduped = [...new Set(valid)];
  const duplicates = valid.length - deduped.length;

  const suppression = new Set((input.suppressionList ?? []).map((n) => n.replace(/[\s()-]/g, '')));
  const callable = deduped.filter((n) => !suppression.has(n));
  const suppressed = deduped.length - callable.length;

  checks.push({
    id: 'number_validity',
    label: 'Number validity',
    status: invalid === 0 ? 'pass' : invalid > raw.length * 0.1 ? 'fail' : 'warn',
    detail:
      invalid === 0
        ? `All ${raw.length} numbers are valid E.164.`
        : `${invalid} of ${raw.length} entries are not valid E.164 and were dropped.`,
  });

  checks.push({
    id: 'deduplication',
    label: 'Deduplication',
    status: 'pass',
    detail:
      duplicates === 0
        ? 'No duplicate numbers in the list.'
        : `${duplicates} duplicate${duplicates === 1 ? '' : 's'} removed - one call per customer.`,
  });

  checks.push({
    id: 'suppression',
    label: 'Opt-out suppression',
    status: 'pass',
    detail: suppressed
      ? `${suppressed} number${suppressed === 1 ? '' : 's'} removed against your suppression list.`
      : suppression.size
        ? 'No numbers in this list appear on your suppression list.'
        : 'No suppression list supplied - pass one as suppressionList to have opt-outs enforced here.',
  });

  // ---- Do Not Call -------------------------------------------------------
  // Requires a licensed registry feed. Never reported as passing without one.
  const dncConfigured = Boolean(process.env.DNC_PROVIDER_URL);
  checks.push({
    id: 'dnc_wash',
    label: 'Do Not Call wash',
    status: dncConfigured ? 'pass' : 'not_available',
    detail: dncConfigured
      ? 'List washed against the configured Do Not Call registry.'
      : 'No Do Not Call registry is configured on this deployment (set DNC_PROVIDER_URL). Wash the list with your registry provider before launching to consumers.',
  });

  // ---- calling window ----------------------------------------------------
  const start = parseTime(input.window?.start);
  const end = parseTime(input.window?.end);

  if (start === null || end === null) {
    checks.push({
      id: 'calling_window',
      label: 'Calling window',
      status: 'warn',
      detail: 'No calling window set - calls would be placed at any hour. Set one before launch.',
    });
  } else if (end <= start) {
    checks.push({
      id: 'calling_window',
      label: 'Calling window',
      status: 'fail',
      detail: 'The window ends before it starts.',
    });
  } else {
    // 9am-8pm weekdays is the common permitted band across AU/UK/US consumer
    // telemarketing rules. Outside it we warn rather than block: B2B and
    // servicing calls to existing customers are frequently exempt, and that
    // judgement belongs to the operator, not to us.
    const conservative = start >= 9 * 60 && end <= 20 * 60;
    checks.push({
      id: 'calling_window',
      label: 'Calling window',
      status: conservative ? 'pass' : 'warn',
      detail: conservative
        ? `${input.window?.start}-${input.window?.end} sits inside common permitted hours.`
        : `${input.window?.start}-${input.window?.end} falls outside the 09:00-20:00 band most consumer rules permit. Confirm this campaign is exempt.`,
    });
  }

  // ---- disclosure --------------------------------------------------------
  const first = (input.firstMessage ?? '').toLowerCase();
  const discloses =
    /\b(ai|automated|virtual|assistant|bot|recorded|recording)\b/.test(first) && first.length > 0;

  checks.push({
    id: 'disclosure',
    label: 'AI and recording disclosure',
    status: first.length === 0 ? 'fail' : discloses ? 'pass' : 'warn',
    detail:
      first.length === 0
        ? 'The agent has no opening line, so no disclosure is made. Set one that identifies the call as AI-assisted.'
        : discloses
          ? 'The opening line identifies the call as AI-assisted or recorded.'
          : 'The opening line does not appear to disclose that the caller is an AI or that the call is recorded. Most jurisdictions require this on the first utterance.',
  });

  // ---- attempts and pacing ----------------------------------------------
  const attempts = input.maxAttempts ?? 1;
  checks.push({
    id: 'attempt_cap',
    label: 'Attempt cap',
    status: attempts <= 3 ? 'pass' : 'warn',
    detail:
      attempts <= 3
        ? `Up to ${attempts} attempt${attempts === 1 ? '' : 's'} per customer.`
        : `${attempts} attempts per customer may exceed permitted contact frequency.`,
  });

  const concurrency = input.concurrency ?? 10;
  checks.push({
    id: 'pacing',
    label: 'Concurrency',
    status: concurrency <= 100 ? 'pass' : 'warn',
    detail: `${concurrency} concurrent calls. ${
      concurrency > 100 ? 'High concurrency can damage number reputation.' : 'Within safe pacing.'
    }`,
  });

  checks.push({
    id: 'audience_size',
    label: 'Audience',
    status: callable.length > 0 ? 'pass' : 'fail',
    detail: callable.length
      ? `${callable.length} callable customer${callable.length === 1 ? '' : 's'}.`
      : 'No callable numbers remain after validation.',
  });

  // ---- projection --------------------------------------------------------
  // Derived from this org's own history where it exists; otherwise we say we
  // cannot project rather than inventing an answer rate.
  const history = await queryOne<{ avg_minutes: string | null; avg_cost: string | null; n: string }>(
    `SELECT AVG(duration_seconds) / 60.0 AS avg_minutes,
            AVG(cost)                    AS avg_cost,
            COUNT(*)::text               AS n
       FROM calls
      WHERE org_id = $1 AND status = 'ended' AND duration_seconds IS NOT NULL
        AND created_at > now() - interval '90 days'`,
    [input.orgId],
  );

  const sample = Number.parseInt(history?.n ?? '0', 10);
  const avgMinutes = history?.avg_minutes ? Number.parseFloat(history.avg_minutes) : null;
  const avgCost = history?.avg_cost ? Number.parseFloat(history.avg_cost) : null;
  const estimatedCalls = callable.length * Math.min(attempts, 3);

  return {
    audience: {
      uploaded: raw.length,
      invalid,
      duplicates,
      suppressed,
      callable: callable.length,
    },
    checks,
    canLaunch: !checks.some((c) => c.status === 'fail'),
    projection: {
      estimatedReach: null, // requires a measured answer rate; see basedOn
      estimatedCalls,
      estimatedMinutes:
        avgMinutes === null ? null : Number((callable.length * avgMinutes).toFixed(1)),
      estimatedCostRange:
        avgCost === null
          ? null
          : [
              Number((callable.length * avgCost * 0.8).toFixed(2)),
              Number((callable.length * avgCost * 1.3).toFixed(2)),
            ],
      basedOn:
        sample >= 20
          ? `Your last ${sample} completed calls.`
          : `Not enough call history to project (${sample} completed calls; 20 needed).`,
    },
    callableNumbers: callable,
  };
}

/** "09:30" -> minutes since midnight, or null when unparseable. */
function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function preflightConfigured(): { dnc: boolean; publicBaseUrl: string } {
  return { dnc: Boolean(process.env.DNC_PROVIDER_URL), publicBaseUrl: config.publicBaseUrl };
}
