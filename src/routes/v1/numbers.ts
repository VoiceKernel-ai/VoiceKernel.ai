import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { queryOne } from '../../db';
import { parseWindow } from '../../lib/http';
import { preflight } from '../../services/campaigns';
import { budgetStatus } from '../../services/billing';
import { listDeliveries, publicDelivery } from '../../services/webhooks';
import { findOwnedResource } from '../../services/resources';
import { ApiError } from '../../errors';

/**
 * Routes that sit alongside the generated CRUD for phone numbers and
 * campaigns. Mounted before the generic router so these paths win, since
 * `/phone-numbers/:id/health` would otherwise be swallowed by `/:id`.
 */

export const numbersExtraRouter = Router();

/**
 * Per-number health, computed from VoiceKernel's own call mirror.
 *
 * The console's number detail view needs answered volume and failure rate for
 * one line. the voice provider has no per-number rollup, and reading every call to count them
 * client-side would not scale - so it is a single aggregate here.
 */
numbersExtraRouter.get(
  '/:id/health',
  requireScope('phone-numbers:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    // Ownership: the generic router's proxy would check this, but this route
    // never reaches the proxy, so it must check for itself.
    const owned = await findOwnedResource(org.id, 'phoneNumber', req.params.id);
    if (!owned) {
      throw ApiError.notFound(`No phone number with id '${req.params.id}' in this organization.`);
    }

    const { since, until } = parseWindow(req, 1);

    const row = await queryOne<{
      total: string;
      answered: string;
      failed: string;
      inbound: string;
      outbound: string;
      avg_duration: string | null;
      total_cost: string | null;
      median_latency: string | null;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'ended'
                            AND COALESCE(ended_reason,'') NOT ILIKE '%no-answer%'
                            AND COALESCE(ended_reason,'') NOT ILIKE '%busy%'
                            AND COALESCE(ended_reason,'') NOT ILIKE '%fail%')::text AS answered,
         COUNT(*) FILTER (WHERE COALESCE(ended_reason,'') ILIKE '%fail%'
                             OR COALESCE(ended_reason,'') ILIKE '%error%')::text    AS failed,
         COUNT(*) FILTER (WHERE direction = 'inbound')::text  AS inbound,
         COUNT(*) FILTER (WHERE direction = 'outbound')::text AS outbound,
         AVG(duration_seconds)::text AS avg_duration,
         SUM(cost)::text             AS total_cost,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY turn_latency_ms)::text AS median_latency
       FROM calls
      WHERE org_id = $1 AND phone_number_id = $2
        AND created_at >= $3 AND created_at <= $4`,
      [org.id, req.params.id, since, until],
    );

    const total = Number.parseInt(row?.total ?? '0', 10);
    const answered = Number.parseInt(row?.answered ?? '0', 10);

    res.json({
      object: 'phone_number.health',
      phoneNumberId: req.params.id,
      window: { since, until },
      calls: {
        total,
        answered,
        failed: Number.parseInt(row?.failed ?? '0', 10),
        inbound: Number.parseInt(row?.inbound ?? '0', 10),
        outbound: Number.parseInt(row?.outbound ?? '0', 10),
        answerRate: total > 0 ? Number((answered / total).toFixed(4)) : null,
      },
      averageDurationSeconds: row?.avg_duration
        ? Number(Number.parseFloat(row.avg_duration).toFixed(1))
        : null,
      cost: row?.total_cost ? Number(Number.parseFloat(row.total_cost).toFixed(4)) : 0,
      medianTurnLatencyMs: row?.median_latency
        ? Math.round(Number.parseFloat(row.median_latency))
        : null,
      // Nothing measured is reported as unknown, not as healthy.
      status: total === 0 ? 'no_traffic' : answered / total >= 0.9 ? 'ok' : 'degraded',
    });
  }),
);

/** Recent event deliveries, for the number detail view's event panel. */
numbersExtraRouter.get(
  '/:id/events',
  requireScope('phone-numbers:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const owned = await findOwnedResource(org.id, 'phoneNumber', req.params.id);
    if (!owned) throw ApiError.notFound('Phone number not found.');

    const deliveries = await listDeliveries(org.id, { limit: 15 });
    res.json({ object: 'list', data: deliveries.map(publicDelivery) });
  }),
);

// ---------------------------------------------------------------------------

export const campaignsExtraRouter = Router();

/**
 * The no-dead-line policy, enforced.
 *
 * A budget breach pauses *new outbound work only*. Inbound calls, in-flight
 * calls and everything else stay untouched - this guard is deliberately scoped
 * to campaign creation and pre-flight, and nowhere else in the codebase checks
 * a budget before answering or continuing a call.
 */
const requireBudgetHeadroom: RequestHandler = asyncHandler(async (req, _res, next) => {
  const org = currentOrg(req);
  const status = await budgetStatus(org);

  if (status.outboundPaused) {
    throw new ApiError(
      402,
      'budget_exhausted',
      `This organization has reached its monthly budget of ${status.budget} (${status.spend} spent), so new outbound campaigns are paused. Live calls and inbound are unaffected. Raise the budget under Settings → Billing to resume.`,
      { details: { period: status.period, budget: status.budget, spend: status.spend } },
    );
  }
  next();
});

campaignsExtraRouter.post('/', requireScope('campaigns:write'), requireBudgetHeadroom, (_req, _res, next) =>
  // Falls through to the generated CRUD router mounted after this one.
  next('router'),
);

const preflightSchema = z.object({
  numbers: z.array(z.string()).max(100_000),
  window: z
    .object({
      start: z.string().optional(),
      end: z.string().optional(),
      days: z.array(z.string()).optional(),
    })
    .optional(),
  firstMessage: z.string().max(10_000).optional(),
  agentId: z.string().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  concurrency: z.number().int().min(1).max(1000).optional(),
  suppressionList: z.array(z.string()).max(100_000).optional(),
});

/**
 * Validates a campaign before it dials anyone.
 *
 * Returns `canLaunch: false` on any hard failure. Checks that need an
 * integration this deployment lacks report `not_available` rather than passing
 * - a green tick for a Do Not Call wash that never happened is worse than no
 * check at all, because the operator would rely on it.
 */
campaignsExtraRouter.post(
  '/preflight',
  requireScope('campaigns:write'),
  requireBudgetHeadroom,
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const input = preflightSchema.parse(req.body ?? {});

    // Pull the opening line from the agent when the caller did not supply one,
    // so the disclosure check runs against what customers will actually hear.
    let firstMessage = input.firstMessage;
    if (!firstMessage && input.agentId) {
      const agent = await findOwnedResource(org.id, 'assistant', input.agentId);
      const snapshot = agent?.snapshot as Record<string, unknown> | undefined;
      if (typeof snapshot?.firstMessage === 'string') firstMessage = snapshot.firstMessage;
    }

    const result = await preflight({
      orgId: org.id,
      numbers: input.numbers,
      window: input.window,
      firstMessage,
      maxAttempts: input.maxAttempts,
      concurrency: input.concurrency,
      suppressionList: input.suppressionList,
    });

    // The callable list can be very large; the caller already has the input.
    const { callableNumbers, ...summary } = result;
    res.json({ object: 'campaign.preflight', ...summary, callableCount: callableNumbers.length });
  }),
);
