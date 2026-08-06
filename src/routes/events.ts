import { Router } from 'express';
import { subscribe } from '../services/realtime';
import { asyncHandler } from '../middleware/context';
import { currentOrg, requireScope } from '../middleware/auth';
import { query } from '../db';
import { listEnvelope, parsePagination, str } from '../lib/http';
import { listAudit, publicAudit } from '../services/audit';

/**
 * /v1/events - the org's event history, and the audit trail beneath it.
 *
 * Kept queryable rather than fire-and-forget because "show me every change to
 * this agent, and every call it took" is the first question a risk reviewer
 * asks during sign-off.
 */
export const eventsRouter = Router();


interface EventRow {
  id: string;
  type: string;
  resource_kind: string | null;
  resource_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}


/**
 * Live event stream for the console.
 *
 * GET /v1/events/stream
 *
 * Everything upstream already lands as a webhook and is written within
 * milliseconds, but the browser had no way to learn that, so an operator
 * watching a call in progress saw nothing until they navigated or pressed
 * Refresh.
 *
 * Server-Sent Events rather than WebSockets: the traffic is one-way, it rides
 * the existing session cookie without a second auth path - EventSource cannot
 * set headers, which is exactly why cookie auth matters here - it survives the
 * proxy as an ordinary HTTP response, and the browser reconnects on its own.
 *
 * Only the event's identity is sent, never its payload. The console refetches
 * the affected view through the ordinary authorised endpoints, so this cannot
 * become a second, less careful way to read tenant data.
 *
 * Declared before '/:id'-shaped routes would be, so "stream" is never read as
 * an id.
 */
eventsRouter.get('/stream', requireScope('calls:read'), (req, res) => {
  const org = currentOrg(req);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Several proxies and CDNs buffer responses by default, which turns a live
  // stream into a long silence followed by a burst.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Widen the browser's 3s reconnect default so an API restart does not
  // produce a thundering herd of reconnects.
  res.write('retry: 5000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ orgId: org.id })}\n\n`);

  const unsubscribe = subscribe(org.id, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Idle connections get reaped by proxies - Cloudflare at 100s. A comment
  // frame costs nothing and keeps the connection classified as active.
  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on('close', close);
  req.on('error', () => close());
});

eventsRouter.get(
  '/',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { limit, offset } = parsePagination(req);

    const filters = ['org_id = $1'];
    const params: unknown[] = [org.id];

    const type = str(req.query.type);
    if (type) {
      params.push(type);
      filters.push(`type = $${params.length}`);
    }
    const resourceId = str(req.query.resourceId);
    if (resourceId) {
      params.push(resourceId);
      filters.push(`resource_id = $${params.length}`);
    }

    const where = filters.join(' AND ');
    const rows = await query<EventRow>(
      `SELECT id, type, resource_kind, resource_id, payload, created_at
         FROM events WHERE ${where}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    res.json(
      listEnvelope(
        rows.map((r) => ({
          id: `evt_${r.id}`,
          object: 'event',
          type: r.type,
          resource: r.resource_kind ? { kind: r.resource_kind, id: r.resource_id } : null,
          data: r.payload,
          createdAt: r.created_at,
        })),
        { limit, offset },
      ),
    );
  }),
);

eventsRouter.get(
  '/audit',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { limit, offset } = parsePagination(req);
    const rows = await listAudit(org.id, {
      limit,
      offset,
      action: str(req.query.action),
      resourceId: str(req.query.resourceId),
    });
    res.json(listEnvelope(rows.map(publicAudit), { limit, offset }));
  }),
);
