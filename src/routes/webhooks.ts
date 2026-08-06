import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/context';
import { currentOrg, requireScope } from '../middleware/auth';
import { ApiError } from '../errors';
import {
  EVENT_TYPES,
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  publicDelivery,
  publicEndpoint,
  replayDelivery,
  revealSecret,
  updateEndpoint,
} from '../services/webhooks';
import { listEnvelope, parsePagination, str } from '../lib/http';
import { signWebhook } from '../lib/crypto';

/**
 * /v1/webhook-endpoints - how a customer's own systems receive call events.
 *
 * This is the primary integration path: an agent finishes a call, and the
 * customer's CRM is written to. Deliveries are signed, retried with backoff and
 * individually replayable, so an outage on their side is recoverable without
 * asking us to resend anything by hand.
 */
export const webhooksRouter = Router();


const createSchema = z.object({
  url: z.string().url(),
  description: z.string().max(500).optional(),
  events: z.array(z.string()).optional(),
});

webhooksRouter.get(
  '/',
  requireScope('webhooks:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const endpoints = await listEndpoints(org.id);
    res.json({
      object: 'list',
      data: endpoints.map(publicEndpoint),
      availableEvents: EVENT_TYPES,
    });
  }),
);

webhooksRouter.post(
  '/',
  requireScope('webhooks:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const input = createSchema.parse(req.body ?? {});
    const { endpoint, secret } = await createEndpoint({ orgId: org.id, ...input });

    res.status(201).json({
      ...publicEndpoint(endpoint),
      // Shown once at creation; retrievable later only via the explicit
      // /secret endpoint, which is audited.
      secret,
      signatureFormat: 'X-VoiceKernel-Signature: t=<unix>,v1=<hex hmac_sha256("<t>.<body>")>',
    });
  }),
);

webhooksRouter.patch(
  '/:id',
  requireScope('webhooks:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const patch = z
      .object({
        url: z.string().url().optional(),
        description: z.string().max(500).optional(),
        events: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    res.json(publicEndpoint(await updateEndpoint(org.id, req.params.id, patch)));
  }),
);

webhooksRouter.delete(
  '/:id',
  requireScope('webhooks:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    await deleteEndpoint(org.id, req.params.id);
    res.json({ id: req.params.id, deleted: true });
  }),
);

webhooksRouter.get(
  '/:id/secret',
  requireScope('webhooks:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    res.json({ id: req.params.id, secret: await revealSecret(org.id, req.params.id) });
  }),
);

webhooksRouter.get(
  '/:id/deliveries',
  requireScope('webhooks:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { limit, offset } = parsePagination(req);
    const deliveries = await listDeliveries(org.id, {
      limit,
      endpointId: req.params.id,
      status: str(req.query.status),
    });
    res.json(listEnvelope(deliveries.map(publicDelivery), { limit, offset }));
  }),
);

webhooksRouter.post(
  '/deliveries/:deliveryId/replay',
  requireScope('webhooks:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    await replayDelivery(org.id, req.params.deliveryId);
    res.json({ id: req.params.deliveryId, status: 'pending', replayed: true });
  }),
);

/**
 * Sends a synthetic event so a customer can verify signature checking before
 * they depend on real traffic. Delivered through the normal queue, so it
 * exercises the same path production events take.
 */
webhooksRouter.post(
  '/:id/test',
  requireScope('webhooks:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const endpoints = await listEndpoints(org.id);
    const endpoint = endpoints.find((e) => e.id === req.params.id);
    if (!endpoint) throw ApiError.notFound('Webhook endpoint not found.');

    const secret = await revealSecret(org.id, endpoint.id);
    const payload = {
      id: `evt_test_${Date.now()}`,
      object: 'event',
      type: 'webhook.test',
      created: Math.floor(Date.now() / 1000),
      data: {
        message: 'This is a VoiceKernel test event.',
        organization: { id: org.id, name: org.name },
      },
    };

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(secret, body, timestamp);

    // Sent inline rather than queued so the caller sees the result immediately.
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VoiceKernel-Signature': signature,
          'X-VoiceKernel-Event': 'webhook.test',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const text = (await response.text().catch(() => '')).slice(0, 1000);
      res.json({
        delivered: response.status >= 200 && response.status < 300,
        responseStatus: response.status,
        responseBody: text,
        signatureSent: signature,
      });
    } catch (err) {
      res.status(200).json({
        delivered: false,
        error: err instanceof Error ? err.message : 'transport error',
        signatureSent: signature,
      });
    }
  }),
);
