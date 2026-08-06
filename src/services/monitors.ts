import { query, queryOne } from '../db';
import { latencyBudget } from './analytics';

/**
 * Monitors and issues.
 *
 * The console's Manage view shows infrastructure, effectiveness and compliance
 * monitors side by side. Rather than a separate alerting stack, each monitor is
 * a query over the call mirror evaluated on read - the data volume is small
 * (one aggregate per monitor over a bounded window) and it means a monitor can
 * never disagree with the analytics screen next to it.
 *
 * A monitor with no data reports `unknown`, never `ok`. "We have not measured
 * this" and "this is healthy" are different answers, and conflating them is how
 * a dashboard ends up reassuring someone during an outage.
 */

export type MonitorState = 'ok' | 'firing' | 'unknown';

export interface Monitor {
  id: string;
  name: string;
  category: 'infrastructure' | 'effectiveness' | 'compliance';
  condition: string;
  state: MonitorState;
  value: number | null;
  threshold: number | null;
  unit: string;
  detail: string;
  /** Recent values for the sparkline, oldest first. */
  sparkline: number[];
}

export interface Issue {
  id: string;
  severity: 'critical' | 'warning' | 'resolved';
  title: string;
  summary: string;
  monitorId: string;
  impactedCalls: number;
  openedAt: string | null;
}

const SLA_MS = 600;

export async function evaluateMonitors(
  orgId: string,
  since: Date,
  until: Date,
): Promise<{ monitors: Monitor[]; issues: Issue[]; slo: { p95: number | null; sla: number; errorBudgetRemaining: number | null } }> {
  const [latency, spark, containment, errors, grounding] = await Promise.all([
    latencyBudget(orgId, since, until, SLA_MS),
    latencySparkline(orgId, since, until),
    containmentTrend(orgId),
    errorRate(orgId, since, until),
    groundingMissRate(orgId, since, until),
  ]);

  const monitors: Monitor[] = [];

  // ---- infrastructure ----------------------------------------------------
  monitors.push({
    id: 'latency_p95',
    name: 'Voice-to-voice latency p95',
    category: 'infrastructure',
    condition: `alert > ${SLA_MS}ms`,
    state: latency.turnP95 === null ? 'unknown' : latency.turnP95 > SLA_MS ? 'firing' : 'ok',
    value: latency.turnP95,
    threshold: SLA_MS,
    unit: 'ms',
    detail:
      latency.turnP95 === null
        ? 'No completed calls with performance metrics in this window.'
        : `p95 ${latency.turnP95}ms across ${latency.sampleSize} measured calls.`,
    sparkline: spark,
  });

  monitors.push({
    id: 'call_error_rate',
    name: 'Call failure rate',
    category: 'infrastructure',
    condition: 'alert > 2% of calls ending in error',
    state: errors.rate === null ? 'unknown' : errors.rate > 0.02 ? 'firing' : 'ok',
    value: errors.rate === null ? null : Number((errors.rate * 100).toFixed(2)),
    threshold: 2,
    unit: '%',
    detail:
      errors.rate === null
        ? 'No calls in this window.'
        : `${errors.failed} of ${errors.total} calls ended in an error state.`,
    sparkline: [],
  });

  // ---- effectiveness -----------------------------------------------------
  monitors.push({
    id: 'containment_drop',
    name: 'Containment rate drop',
    category: 'effectiveness',
    condition: 'alert if 24h containment falls 5pts below the 7d baseline',
    state:
      containment.recent === null || containment.baseline === null
        ? 'unknown'
        : containment.recent < containment.baseline - 0.05
          ? 'firing'
          : 'ok',
    value: containment.recent === null ? null : Number((containment.recent * 100).toFixed(1)),
    threshold:
      containment.baseline === null ? null : Number(((containment.baseline - 0.05) * 100).toFixed(1)),
    unit: '%',
    detail:
      containment.recent === null
        ? 'Not enough calls in the last 24 hours.'
        : containment.baseline === null
          ? 'No 7-day baseline yet.'
          : `24h ${(containment.recent * 100).toFixed(1)}% vs 7d baseline ${(containment.baseline * 100).toFixed(1)}%.`,
    sparkline: containment.spark,
  });

  // ---- compliance --------------------------------------------------------
  monitors.push({
    id: 'grounding_miss',
    name: 'Grounding miss rate',
    category: 'compliance',
    condition: 'alert > 2% of ended calls with no analysis or summary recorded',
    state: grounding.rate === null ? 'unknown' : grounding.rate > 0.02 ? 'firing' : 'ok',
    value: grounding.rate === null ? null : Number((grounding.rate * 100).toFixed(2)),
    threshold: 2,
    unit: '%',
    detail:
      grounding.rate === null
        ? 'No completed calls in this window.'
        : `${grounding.missing} of ${grounding.total} completed calls have no recorded analysis.`,
    sparkline: [],
  });

  // PCI redaction integrity requires sampling stored audio against a detector,
  // which this deployment does not run. Reported as unknown rather than a
  // reassuring zero - a false "0 misses" here is a compliance liability.
  monitors.push({
    id: 'pci_redaction',
    name: 'PCI redaction integrity',
    category: 'compliance',
    condition: 'alert on any missed redaction in the nightly sample',
    state: 'unknown',
    value: null,
    threshold: 0,
    unit: 'misses',
    detail:
      'No redaction auditor is configured on this deployment. Enable compliancePlan.pciEnabled on your agents and connect an audit sampler to populate this monitor.',
    sparkline: [],
  });

  // ---- issues ------------------------------------------------------------
  const issues: Issue[] = monitors
    .filter((m) => m.state === 'firing')
    .map((m) => ({
      id: `issue_${m.id}`,
      severity: m.category === 'compliance' ? 'critical' : 'warning',
      title: `${m.name} - threshold breached`,
      summary: m.detail,
      monitorId: m.id,
      impactedCalls: 0,
      openedAt: null,
    }));

  return {
    monitors,
    issues,
    slo: {
      p95: latency.turnP95,
      sla: SLA_MS,
      errorBudgetRemaining:
        latency.turnP95 === null ? null : Number(Math.max(0, 1 - latency.turnP95 / SLA_MS).toFixed(3)),
    },
  };
}

/** Daily p95 latency for the monitor sparkline. */
async function latencySparkline(orgId: string, since: Date, until: Date): Promise<number[]> {
  const rows = await query<{ p95: string | null }>(
    `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY turn_latency_ms)::text AS p95
       FROM calls
      WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3 AND turn_latency_ms IS NOT NULL
      GROUP BY date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at) ASC
      LIMIT 14`,
    [orgId, since, until],
  );
  return rows.map((r) => (r.p95 ? Math.round(Number.parseFloat(r.p95)) : 0));
}

const CONTAINED = `status = 'ended'
  AND COALESCE(ended_reason,'') NOT ILIKE '%transfer%'
  AND COALESCE(ended_reason,'') NOT ILIKE '%escalat%'`;

async function containmentTrend(
  orgId: string,
): Promise<{ recent: number | null; baseline: number | null; spark: number[] }> {
  const row = await queryOne<{
    recent_total: string;
    recent_contained: string;
    base_total: string;
    base_contained: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::text AS recent_total,
       COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND ${CONTAINED})::text AS recent_contained,
       COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::text AS base_total,
       COUNT(*) FILTER (WHERE created_at > now() - interval '7 days' AND ${CONTAINED})::text AS base_contained
     FROM calls WHERE org_id = $1`,
    [orgId],
  );

  const recentTotal = Number.parseInt(row?.recent_total ?? '0', 10);
  const baseTotal = Number.parseInt(row?.base_total ?? '0', 10);

  const spark = await query<{ rate: string | null }>(
    `SELECT (COUNT(*) FILTER (WHERE ${CONTAINED})::numeric / NULLIF(COUNT(*), 0))::text AS rate
       FROM calls
      WHERE org_id = $1 AND created_at > now() - interval '14 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at) ASC`,
    [orgId],
  );

  return {
    recent: recentTotal > 0 ? Number.parseInt(row!.recent_contained, 10) / recentTotal : null,
    baseline: baseTotal > 0 ? Number.parseInt(row!.base_contained, 10) / baseTotal : null,
    spark: spark.map((r) => (r.rate ? Math.round(Number.parseFloat(r.rate) * 100) : 0)),
  };
}

async function errorRate(
  orgId: string,
  since: Date,
  until: Date,
): Promise<{ rate: number | null; failed: number; total: number }> {
  const row = await queryOne<{ total: string; failed: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE COALESCE(ended_reason,'') ILIKE '%error%'
                                OR COALESCE(ended_reason,'') ILIKE '%fail%')::text AS failed
       FROM calls WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [orgId, since, until],
  );
  const total = Number.parseInt(row?.total ?? '0', 10);
  const failed = Number.parseInt(row?.failed ?? '0', 10);
  return { rate: total > 0 ? failed / total : null, failed, total };
}

/**
 * Proxy for "the agent answered without grounding": a completed call with no
 * analysis recorded. It is a proxy, not a measurement of citations - the provider does
 * not report per-utterance citation coverage, and the monitor's `condition`
 * says exactly what it counts so nobody mistakes it for more than that.
 */
async function groundingMissRate(
  orgId: string,
  since: Date,
  until: Date,
): Promise<{ rate: number | null; missing: number; total: number }> {
  const row = await queryOne<{ total: string; missing: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE analysis IS NULL AND summary IS NULL)::text AS missing
       FROM calls
      WHERE org_id = $1 AND status = 'ended' AND created_at >= $2 AND created_at <= $3`,
    [orgId, since, until],
  );
  const total = Number.parseInt(row?.total ?? '0', 10);
  const missing = Number.parseInt(row?.missing ?? '0', 10);
  return { rate: total > 0 ? missing / total : null, missing, total };
}

/**
 * Escalation reasons, for the Insights view's "why calls escalate" breakdown.
 * Grouped from ended_reason, which is the only structured signal the provider gives.
 */
export async function escalationReasons(
  orgId: string,
  since: Date,
  until: Date,
): Promise<Array<{ reason: string; count: number; share: number }>> {
  const rows = await query<{ reason: string; count: string }>(
    `SELECT
       CASE
         WHEN ended_reason ILIKE '%transfer%'   THEN 'Transferred to a human'
         WHEN ended_reason ILIKE '%escalat%'    THEN 'Escalated'
         WHEN ended_reason ILIKE '%voicemail%'  THEN 'Voicemail'
         WHEN ended_reason ILIKE '%no-answer%'  THEN 'No answer'
         WHEN ended_reason ILIKE '%busy%'       THEN 'Busy'
         WHEN ended_reason ILIKE '%error%'
           OR ended_reason ILIKE '%fail%'       THEN 'Pipeline error'
         WHEN ended_reason ILIKE '%customer%'   THEN 'Customer ended the call'
         WHEN ended_reason ILIKE '%assistant%'  THEN 'Agent ended the call'
         ELSE COALESCE(ended_reason, 'Unknown')
       END AS reason,
       COUNT(*)::text AS count
     FROM calls
      WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3 AND ended_reason IS NOT NULL
      GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 12`,
    [orgId, since, until],
  );

  const total = rows.reduce((sum, r) => sum + Number.parseInt(r.count, 10), 0);
  return rows.map((r) => {
    const count = Number.parseInt(r.count, 10);
    return { reason: r.reason, count, share: total > 0 ? Number((count / total).toFixed(4)) : 0 };
  });
}
