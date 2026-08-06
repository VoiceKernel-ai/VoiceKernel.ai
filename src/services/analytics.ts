import { query, queryOne } from '../db';

/**
 * Org-scoped analytics computed from VoiceKernel's own `calls` mirror.
 *
 * We do not proxy the voice provider's /analytics in platform mode: that endpoint aggregates
 * over the whole provider account, which on a shared platform key is every tenant
 * at once. Computing locally is both safe and cheaper.
 */

export interface OverviewMetrics {
  window: { since: string; until: string };
  calls: {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    containmentRate: number | null;
  };
  minutes: { total: number; average: number | null };
  cost: { total: number; perCall: number | null };
  latency: { p50: number | null; p95: number | null };
}

export async function overview(
  orgId: string,
  since: Date,
  until: Date,
): Promise<OverviewMetrics> {
  const row = await queryOne<{
    total: string;
    completed: string;
    failed: string;
    in_progress: string;
    contained: string;
    total_seconds: string | null;
    avg_seconds: string | null;
    total_cost: string | null;
  }>(
    `SELECT
       COUNT(*)::text                                                       AS total,
       COUNT(*) FILTER (WHERE status = 'ended' AND ended_reason NOT ILIKE '%error%')::text AS completed,
       COUNT(*) FILTER (WHERE ended_reason ILIKE '%error%' OR ended_reason ILIKE '%fail%')::text AS failed,
       COUNT(*) FILTER (WHERE status IN ('queued','ringing','in-progress','forwarding'))::text AS in_progress,
       -- "Contained" = resolved by the agent without a human transfer.
       COUNT(*) FILTER (WHERE status = 'ended'
                          AND COALESCE(ended_reason,'') NOT ILIKE '%transfer%'
                          AND COALESCE(ended_reason,'') NOT ILIKE '%escalat%')::text AS contained,
       SUM(duration_seconds)::text                                          AS total_seconds,
       AVG(duration_seconds)::text                                          AS avg_seconds,
       SUM(cost)::text                                                      AS total_cost
     FROM calls
     WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [orgId, since, until],
  );

  const total = Number.parseInt(row?.total ?? '0', 10);
  const contained = Number.parseInt(row?.contained ?? '0', 10);
  const completed = Number.parseInt(row?.completed ?? '0', 10);
  const totalSeconds = Number.parseFloat(row?.total_seconds ?? '0') || 0;
  const avgSeconds = row?.avg_seconds ? Number.parseFloat(row.avg_seconds) : null;
  const totalCost = Number.parseFloat(row?.total_cost ?? '0') || 0;

  const latency = await latencyPercentiles(orgId, since, until);

  return {
    window: { since: since.toISOString(), until: until.toISOString() },
    calls: {
      total,
      completed,
      failed: Number.parseInt(row?.failed ?? '0', 10),
      inProgress: Number.parseInt(row?.in_progress ?? '0', 10),
      containmentRate: total > 0 ? Number((contained / total).toFixed(4)) : null,
    },
    minutes: {
      total: Number((totalSeconds / 60).toFixed(2)),
      average: avgSeconds === null ? null : Number((avgSeconds / 60).toFixed(2)),
    },
    cost: {
      total: Number(totalCost.toFixed(4)),
      perCall: total > 0 ? Number((totalCost / total).toFixed(4)) : null,
    },
    latency,
  };
}

/**
 * Turn-latency percentiles, read from the denormalised columns.
 *
 * The provider publishes these under `artifact.performanceMetrics` and only once a call
 * has ended, so calls still in flight are excluded rather than counted as zero.
 * When nothing has been measured we return null - an unmeasured window and a
 * fast one must not look the same.
 */
async function latencyPercentiles(
  orgId: string,
  since: Date,
  until: Date,
): Promise<{ p50: number | null; p95: number | null }> {
  const row = await queryOne<{ p50: string | null; p95: string | null }>(
    `SELECT
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY turn_latency_ms)::text AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY turn_latency_ms)::text AS p95
     FROM calls
      WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3
        AND turn_latency_ms IS NOT NULL`,
    [orgId, since, until],
  );
  return {
    p50: row?.p50 ? Math.round(Number.parseFloat(row.p50)) : null,
    p95: row?.p95 ? Math.round(Number.parseFloat(row.p95)) : null,
  };
}

export interface LatencyBudget {
  /** Calls with measured performance metrics in the window. */
  sampleSize: number;
  slaMs: number;
  stages: Array<{ stage: string; label: string; p50: number | null; share: number | null }>;
  totalP50: number | null;
  turnP50: number | null;
  turnP95: number | null;
  headroomMs: number | null;
  withinSla: boolean | null;
  interruptions: { byUser: number | null; byAgent: number | null };
}

/**
 * The voice-to-voice latency budget: where the round trip is actually spent.
 *
 * Stage figures are the voice provider's per-call averages, then aggregated to a p50 across
 * the window. `totalP50` sums the stage medians and will not exactly equal
 * `turnP50` - medians are not additive, and turn latency includes network and
 * VAD overhead the stages exclude. Both are reported rather than reconciled,
 * because pretending they are the same number would hide that overhead.
 */
export async function latencyBudget(
  orgId: string,
  since: Date,
  until: Date,
  slaMs = 600,
): Promise<LatencyBudget> {
  const row = await queryOne<Record<string, string | null>>(
    `SELECT
       COUNT(*)::text AS samples,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY transcriber_latency_ms)::text AS stt,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY model_latency_ms)::text       AS llm,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY voice_latency_ms)::text       AS tts,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY endpointing_latency_ms)::text AS endpointing,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY turn_latency_ms)::text        AS turn_p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY turn_latency_ms)::text       AS turn_p95,
       AVG(user_interruptions)::text                                             AS user_int,
       AVG(agent_interruptions)::text                                            AS agent_int
     FROM calls
      WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3
        AND turn_latency_ms IS NOT NULL`,
    [orgId, since, until],
  );

  const num = (v: string | null | undefined): number | null =>
    v === null || v === undefined ? null : Math.round(Number.parseFloat(v) * 100) / 100;

  const stages = [
    { stage: 'transcriber', label: 'STT', p50: num(row?.stt) },
    { stage: 'model', label: 'Reasoning', p50: num(row?.llm) },
    { stage: 'voice', label: 'TTS', p50: num(row?.tts) },
    { stage: 'endpointing', label: 'Endpointing', p50: num(row?.endpointing) },
  ];

  const measured = stages.filter((s) => s.p50 !== null);
  const totalP50 = measured.length
    ? Math.round(measured.reduce((sum, s) => sum + (s.p50 ?? 0), 0))
    : null;

  const turnP50 = num(row?.turn_p50);

  return {
    sampleSize: Number.parseInt(row?.samples ?? '0', 10),
    slaMs,
    stages: stages.map((s) => ({
      ...s,
      share: totalP50 && s.p50 !== null ? Number((s.p50 / totalP50).toFixed(4)) : null,
    })),
    totalP50,
    turnP50,
    turnP95: num(row?.turn_p95),
    headroomMs: turnP50 === null ? null : Math.round(slaMs - turnP50),
    withinSla: turnP50 === null ? null : turnP50 <= slaMs,
    interruptions: {
      byUser: row?.user_int ? Number(Number.parseFloat(row.user_int).toFixed(2)) : null,
      byAgent: row?.agent_int ? Number(Number.parseFloat(row.agent_int).toFixed(2)) : null,
    },
  };
}

export interface TimeseriesPoint {
  bucket: string;
  calls: number;
  minutes: number;
  cost: number;
}

export async function timeseries(
  orgId: string,
  since: Date,
  until: Date,
  granularity: 'hour' | 'day' | 'week' = 'day',
): Promise<TimeseriesPoint[]> {
  // Whitelisted, never interpolated from user input directly.
  const unit = granularity === 'hour' ? 'hour' : granularity === 'week' ? 'week' : 'day';

  const rows = await query<{
    bucket: Date;
    calls: string;
    seconds: string | null;
    cost: string | null;
  }>(
    `SELECT date_trunc('${unit}', created_at) AS bucket,
            COUNT(*)::text                    AS calls,
            SUM(duration_seconds)::text       AS seconds,
            SUM(cost)::text                   AS cost
       FROM calls
      WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3
      GROUP BY 1 ORDER BY 1 ASC`,
    [orgId, since, until],
  );

  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    calls: Number.parseInt(r.calls, 10),
    minutes: Number(((Number.parseFloat(r.seconds ?? '0') || 0) / 60).toFixed(2)),
    cost: Number((Number.parseFloat(r.cost ?? '0') || 0).toFixed(4)),
  }));
}

export interface AgentBreakdown {
  assistantId: string | null;
  name: string | null;
  calls: number;
  minutes: number;
  cost: number;
  containmentRate: number | null;
}

export async function byAgent(
  orgId: string,
  since: Date,
  until: Date,
): Promise<AgentBreakdown[]> {
  const rows = await query<{
    assistant_id: string | null;
    name: string | null;
    calls: string;
    seconds: string | null;
    cost: string | null;
    contained: string;
  }>(
    `SELECT c.assistant_id,
            r.name,
            COUNT(*)::text              AS calls,
            SUM(c.duration_seconds)::text AS seconds,
            SUM(c.cost)::text           AS cost,
            COUNT(*) FILTER (WHERE c.status = 'ended'
                               AND COALESCE(c.ended_reason,'') NOT ILIKE '%transfer%'
                               AND COALESCE(c.ended_reason,'') NOT ILIKE '%escalat%')::text AS contained
       FROM calls c
       LEFT JOIN resources r
              ON r.provider_id = c.assistant_id AND r.kind = 'assistant' AND r.org_id = c.org_id
      WHERE c.org_id = $1 AND c.created_at >= $2 AND c.created_at <= $3
      GROUP BY c.assistant_id, r.name
      ORDER BY COUNT(*) DESC
      LIMIT 50`,
    [orgId, since, until],
  );

  return rows.map((r) => {
    const calls = Number.parseInt(r.calls, 10);
    const contained = Number.parseInt(r.contained, 10);
    return {
      assistantId: r.assistant_id,
      name: r.name,
      calls,
      minutes: Number(((Number.parseFloat(r.seconds ?? '0') || 0) / 60).toFixed(2)),
      cost: Number((Number.parseFloat(r.cost ?? '0') || 0).toFixed(4)),
      containmentRate: calls > 0 ? Number((contained / calls).toFixed(4)) : null,
    };
  });
}

export async function endedReasonBreakdown(
  orgId: string,
  since: Date,
  until: Date,
): Promise<Array<{ reason: string; count: number }>> {
  const rows = await query<{ ended_reason: string | null; count: string }>(
    `SELECT ended_reason, COUNT(*)::text AS count
       FROM calls
      WHERE org_id = $1 AND created_at >= $2 AND created_at <= $3 AND ended_reason IS NOT NULL
      GROUP BY ended_reason ORDER BY COUNT(*) DESC LIMIT 25`,
    [orgId, since, until],
  );
  return rows.map((r) => ({
    reason: r.ended_reason ?? 'unknown',
    count: Number.parseInt(r.count, 10),
  }));
}
