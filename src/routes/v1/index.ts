import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/ratelimit';
import { idempotency } from '../../middleware/idempotency';
import { auditRequests } from '../../middleware/audit';
import { agentsRouter } from './agents';
import { observeRouter } from './observe';
import { governanceRouter, subjectsRouter } from './governance';
import { campaignsExtraRouter, numbersExtraRouter } from './numbers';
import { callsRouter } from './calls';
import { filesRouter } from './files';
import { catalogRouter } from './catalog';
import { analyticsRouter } from './analytics';
import { passthroughRouter } from './passthrough';
import { RESOURCE_ROUTES, resourceRouter } from './generic';
import { webhooksRouter } from '../webhooks';
import { apiKeysRouter } from '../apikeys';
import { organizationRouter } from '../organization';
import { eventsRouter } from '../events';

/**
 * The public VoiceKernel API.
 *
 * Two layers, deliberately:
 *   1. Native routes - the ergonomic surface (agents, calls, analytics) that
 *      hides the voice provider's shape and adds tenant scoping.
 *   2. /v1/provider/* - complete, mediated coverage of every provider operation, so no
 *      customer is ever blocked by a gap in layer 1.
 */
export const v1Router = Router();

// ---------------------------------------------------------------------------
// Request pipeline.
//
// Authentication runs once here rather than per sub-router, because everything
// below it needs the resolved tenant: idempotency keys are scoped per org, and
// the audit trail records which credential acted. Mounted at the app level (as
// they were originally) both would silently no-op - req.org is not populated
// until auth has run.
//
// Individual routes still declare `requireScope`, which is a check on the
// already-authenticated credential.
// ---------------------------------------------------------------------------
v1Router.use(requireAuth());
v1Router.use(rateLimit());
v1Router.use(idempotency());
v1Router.use(auditRequests());

// Native, opinionated resources.
v1Router.use('/agents', agentsRouter);
// the provider calls them assistants; both names reach the same objects.
v1Router.use('/assistants', agentsRouter);
v1Router.use('/calls', callsRouter);
v1Router.use('/files', filesRouter);
v1Router.use('/catalog', catalogRouter);
v1Router.use('/analytics', analyticsRouter);

// Observe + Manage: monitors, eval gates, schemas, voices, access, routing.
v1Router.use('/observe', observeRouter);
v1Router.use('/governance', governanceRouter);
v1Router.use('/subjects', subjectsRouter);

// Sub-resource routes must be mounted before the generated CRUD, or
// `/phone-numbers/:id` would swallow `/phone-numbers/:id/health`.
v1Router.use('/phone-numbers', numbersExtraRouter);
v1Router.use('/campaigns', campaignsExtraRouter);

// Generated CRUD for the remaining provider collections.
for (const cfg of RESOURCE_ROUTES) {
  v1Router.use(`/${cfg.segment}`, resourceRouter(cfg));
}

// VoiceKernel-native platform resources (no provider equivalent).
v1Router.use('/webhook-endpoints', webhooksRouter);
v1Router.use('/events', eventsRouter);
v1Router.use('/api-keys', apiKeysRouter);
v1Router.use('/organization', organizationRouter);

// Full passthrough. Registered last so it never shadows a native route.
v1Router.use('/provider', passthroughRouter);
