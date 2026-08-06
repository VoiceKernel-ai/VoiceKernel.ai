import { config } from '../config';
import { query, queryOne } from '../db';
import { ApiError } from '../errors';
import { publish } from './realtime';
import { logger } from '../logger';
import { decryptSecret, encryptSecret, randomToken, signWebhook } from '../lib/crypto';

export interface WebhookEndpointRow {
  id: string;
  org_id: string;
  url: string;
  description: string | null;
  secret_cipher: string;
  secret_last4: string;
  events: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WebhookDeliveryRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  event_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  next_attempt_at: Date;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

/**
 * Event types VoiceKernel emits. the voice provider's own `message.type` values are mapped
 * onto these so integrators code against our vocabulary, not the upstream's.
 */
export const EVENT_TYPES = [
  'call.started',
  'call.ended',
  'call.updated',
  'call.transcript',
  'call.status-update',
  'call.speech-update',
  'call.hang',
  'call.analysis.completed',
  'tool.called',
  'assistant.requested',
  'transfer.destination.requested',
  'agent.created',
  'agent.updated',
  'agent.deleted',
] as const;

export type EventType = (typeof EVENT_TYPES)[number] | string;

// ---------------------------------------------------------------------------
// Endpoint management
// ---------------------------------------------------------------------------

export async function createEndpoint(params: {
  orgId: string;
  url: string;
  description?: string;
  events?: string[];
}): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  assertDeliverableUrl(params.url);

  const secret = `whsec_${randomToken(24)}`;
  const row = await queryOne<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints (org_id, url, description, secret_cipher, secret_last4, events)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      params.orgId,
      params.url,
      params.description ?? null,
      encryptSecret(secret),
      secret.slice(-4),
      params.events?.length ? params.events : ['*'],
    ],
  );
  if (!row) throw ApiError.internal('Could not create webhook endpoint.');
  return { endpoint: row, secret };
}

/**
 * Blocks obviously undeliverable or dangerous targets. A tenant-supplied URL is
 * fetched by our servers, so an unchecked value is an SSRF primitive - loopback
 * and link-local hosts are refused outright.
 */
export function assertDeliverableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest('Webhook URL must be an absolute http(s) URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw ApiError.badRequest('Webhook URL must use http or https.');
  }
  if (config.isProd && url.protocol !== 'https:') {
    throw ApiError.badRequest('Webhook URL must use https.');
  }

  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (blocked && config.isProd) {
    throw ApiError.badRequest('Webhook URL may not point at a private or loopback address.');
  }
  return url;
}

export async function listEndpoints(orgId: string): Promise<WebhookEndpointRow[]> {
  return query<WebhookEndpointRow>(
    `SELECT * FROM webhook_endpoints WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
}

export async function updateEndpoint(
  orgId: string,
  id: string,
  patch: { url?: string; description?: string; events?: string[]; enabled?: boolean },
): Promise<WebhookEndpointRow> {
  if (patch.url) assertDeliverableUrl(patch.url);

  const sets: string[] = [];
  const params: unknown[] = [id, orgId];
  const add = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.url !== undefined) add('url', patch.url);
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.events !== undefined) add('events', patch.events);
  if (patch.enabled !== undefined) add('enabled', patch.enabled);

  if (!sets.length) {
    const current = await queryOne<WebhookEndpointRow>(
      `SELECT * FROM webhook_endpoints WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!current) throw ApiError.notFound('Webhook endpoint not found.');
    return current;
  }

  const row = await queryOne<WebhookEndpointRow>(
    `UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
    params,
  );
  if (!row) throw ApiError.notFound('Webhook endpoint not found.');
  return row;
}

export async function deleteEndpoint(orgId: string, id: string): Promise<void> {
  const row = await queryOne(
    `DELETE FROM webhook_endpoints WHERE id = $1 AND org_id = $2 RETURNING id`,
    [id, orgId],
  );
  if (!row) throw ApiError.notFound('Webhook endpoint not found.');
}

export async function revealSecret(orgId: string, id: string): Promise<string> {
  const row = await queryOne<WebhookEndpointRow>(
    `SELECT * FROM webhook_endpoints WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  if (!row) throw ApiError.notFound('Webhook endpoint not found.');
  return decryptSecret(row.secret_cipher);
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

function subscribes(endpoint: WebhookEndpointRow, eventType: string): boolean {
  if (endpoint.events.includes('*')) return true;
  if (endpoint.events.includes(eventType)) return true;
  // Prefix subscription: "call.*" matches "call.ended".
  const [namespace] = eventType.split('.');
  return endpoint.events.includes(`${namespace}.*`);
}

/**
 * Persists an event and enqueues a delivery for every subscribed endpoint.
 * Delivery itself is the worker's job - an inbound provider webhook must return
 * quickly, or the provider will retry and we will double-process.
 */
export async function emitEvent(params: {
  orgId: string;
  type: EventType;
  resourceKind?: string | null;
  resourceId?: string | null;
  payload: Record<string, unknown>;
}): Promise<{ eventId: string; queued: number }> {
  const event = await queryOne<{ id: string; created_at: Date }>(
    `INSERT INTO events (org_id, type, resource_kind, resource_id, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id, created_at`,
    [
      params.orgId,
      params.type,
      params.resourceKind ?? null,
      params.resourceId ?? null,
      JSON.stringify(params.payload),
    ],
  );
  if (!event) throw ApiError.internal('Could not record event.');

  // Tell any console watching this org, before the customer-webhook fan-out:
  // that work involves more queries and HTTP, and the operator staring at the
  // screen should not wait behind it.
  publish(params.orgId, {
    id: event.id,
    type: params.type,
    resourceKind: params.resourceKind ?? null,
    resourceId: params.resourceId ?? null,
    at: event.created_at.toISOString(),
  });

  const endpoints = (await listEndpoints(params.orgId)).filter(
    (e) => e.enabled && subscribes(e, params.type),
  );

  const envelope = {
    id: `evt_${event.id}`,
    object: 'event',
    type: params.type,
    created: Math.floor(event.created_at.getTime() / 1000),
    data: params.payload,
  };

  for (const endpoint of endpoints) {
    await query(
      `INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [params.orgId, endpoint.id, event.id, params.type, JSON.stringify(envelope)],
    );
  }

  return { eventId: event.id, queued: endpoints.length };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Claims a batch of due deliveries.
 *
 * SKIP LOCKED is what makes it safe to run several API instances: each worker
 * takes a disjoint batch instead of every instance racing on the same rows.
 */
export async function claimDueDeliveries(limit = 20): Promise<WebhookDeliveryRow[]> {
  return query<WebhookDeliveryRow>(
    `UPDATE webhook_deliveries SET status = 'delivering'
      WHERE id IN (
        SELECT id FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
}

export async function attemptDelivery(delivery: WebhookDeliveryRow): Promise<void> {
  const endpoint = await queryOne<WebhookEndpointRow>(
    `SELECT * FROM webhook_endpoints WHERE id = $1`,
    [delivery.endpoint_id],
  );

  if (!endpoint || !endpoint.enabled) {
    await query(
      `UPDATE webhook_deliveries SET status = 'dead', error = $2 WHERE id = $1`,
      [delivery.id, 'Endpoint removed or disabled before delivery.'],
    );
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhook(decryptSecret(endpoint.secret_cipher), body, timestamp);
  const attempt = delivery.attempts + 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VoiceKernel-Webhooks/1.0',
        'X-VoiceKernel-Signature': signature,
        'X-VoiceKernel-Event': delivery.event_type,
        'X-VoiceKernel-Delivery': delivery.id,
        'X-VoiceKernel-Attempt': String(attempt),
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });

    const text = (await res.text().catch(() => '')).slice(0, 2000);

    if (res.status >= 200 && res.status < 300) {
      await query(
        `UPDATE webhook_deliveries
            SET status = 'succeeded', attempts = $2, response_status = $3,
                response_body = $4, delivered_at = now(), error = NULL
          WHERE id = $1`,
        [delivery.id, attempt, res.status, text],
      );
      return;
    }

    await scheduleRetry(delivery, attempt, res.status, text, `Endpoint returned ${res.status}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'transport error';
    await scheduleRetry(delivery, attempt, null, null, message);
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff: ~5s, 25s, 2m, 10m, 50m, capped at 6h. */
async function scheduleRetry(
  delivery: WebhookDeliveryRow,
  attempt: number,
  responseStatus: number | null,
  responseBody: string | null,
  error: string,
): Promise<void> {
  if (attempt >= config.webhooks.maxAttempts) {
    await query(
      `UPDATE webhook_deliveries
          SET status = 'dead', attempts = $2, response_status = $3, response_body = $4, error = $5
        WHERE id = $1`,
      [delivery.id, attempt, responseStatus, responseBody, error],
    );
    logger.warn(
      { deliveryId: delivery.id, attempts: attempt, error },
      'webhook delivery exhausted retries',
    );
    return;
  }

  const delaySeconds = Math.min(5 * 5 ** (attempt - 1), 6 * 60 * 60);
  await query(
    `UPDATE webhook_deliveries
        SET status = 'pending', attempts = $2, response_status = $3, response_body = $4,
            error = $5, next_attempt_at = now() + ($6 || ' seconds')::interval
      WHERE id = $1`,
    [delivery.id, attempt, responseStatus, responseBody, error, String(delaySeconds)],
  );
}

export async function listDeliveries(
  orgId: string,
  opts: { limit?: number; status?: string; endpointId?: string } = {},
): Promise<WebhookDeliveryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters = ['org_id = $1'];
  const params: unknown[] = [orgId];
  if (opts.status) {
    params.push(opts.status);
    filters.push(`status = $${params.length}`);
  }
  if (opts.endpointId) {
    params.push(opts.endpointId);
    filters.push(`endpoint_id = $${params.length}`);
  }
  return query<WebhookDeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
}

/** Requeues a dead or failed delivery for immediate retry. */
export async function replayDelivery(orgId: string, deliveryId: string): Promise<void> {
  const row = await queryOne(
    `UPDATE webhook_deliveries
        SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL
      WHERE id = $1 AND org_id = $2
      RETURNING id`,
    [deliveryId, orgId],
  );
  if (!row) throw ApiError.notFound('Delivery not found.');
}

export function publicEndpoint(row: WebhookEndpointRow) {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    enabled: row.enabled,
    secretLast4: row.secret_last4,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicDelivery(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    error: row.error,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}
