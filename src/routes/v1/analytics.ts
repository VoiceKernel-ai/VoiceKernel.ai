import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { parseWindow, str } from '../../lib/http';
import {
  byAgent,
  endedReasonBreakdown,
  latencyBudget,
  overview,
  timeseries,
} from '../../services/analytics';
import { proxyToProvider } from '../../services/proxy';
import { countByKind } from '../../services/resources';

/**
 * Analytics computed from VoiceKernel's own call mirror.
 *
 * the voice provider's /analytics aggregates across the entire provider account. On the shared
 * platform key that is every tenant at once, so proxying it would be a
 * cross-tenant disclosure. Everything here is org-scoped by construction.
 * Tenants on their own provider key can still reach the upstream endpoint
 * through the passthrough surface, where the request carries their own
 * credentials and so spans only their own data.
 */
export const analyticsRouter = Router();


analyticsRouter.get(
  '/overview',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    const [metrics, resources] = await Promise.all([
      overview(org.id, since, until),
      countByKind(org.id),
    ]);
    res.json({ object: 'analytics.overview', ...metrics, resources });
  }),
);

analyticsRouter.get(
  '/timeseries',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    const granularity = z
      .enum(['hour', 'day', 'week'])
      .catch('day')
      .parse(str(req.query.granularity));

    res.json({
      object: 'analytics.timeseries',
      granularity,
      window: { since, until },
      data: await timeseries(org.id, since, until, granularity),
    });
  }),
);

/**
 * Voice-to-voice latency budget: where the round trip is spent, against an SLA.
 *
 * Measured from the voice provider's per-call performance metrics, which only exist for ended
 * calls. A window with no measurements reports nulls and a sampleSize of 0
 * rather than zeros, so the console can say "not measured yet" instead of
 * drawing a flat, fast-looking bar.
 */
analyticsRouter.get(
  '/latency',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    const sla = z.coerce.number().int().min(100).max(10_000).catch(600).parse(req.query.slaMs);

    res.json({
      object: 'analytics.latency',
      window: { since, until },
      ...(await latencyBudget(org.id, since, until, sla)),
    });
  }),
);

analyticsRouter.get(
  '/agents',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    res.json({
      object: 'analytics.agents',
      window: { since, until },
      data: await byAgent(org.id, since, until),
    });
  }),
);

analyticsRouter.get(
  '/ended-reasons',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    res.json({
      object: 'analytics.ended_reasons',
      window: { since, until },
      data: await endedReasonBreakdown(org.id, since, until),
    });
  }),
);

/**
 * Raw Raw upstream analytics queries. Available only to tenants on their own provider key - * the proxy refuses this operation on the shared platform key.
 */
analyticsRouter.post(
  '/provider',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'POST',
      path: '/analytics',
      body: req.body,
    });
    res.status(result.status).json(result.data);
  }),
);
