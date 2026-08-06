import { Router } from 'express';
import { asyncHandler } from '../middleware/context';
import { config } from '../config';
import { logger } from '../logger';
import { safeEqual } from '../lib/crypto';
import { getOrg } from '../services/org';
import { recordCallFromProvider } from '../services/calls';
import { emitEvent } from '../services/webhooks';
import { resolveOwner } from '../services/resources';
import { queryOne } from '../db';

/**
 * Inbound events from the voice provider.
 *
 * Every assistant VoiceKernel creates is pointed at /webhooks/provider/:orgId, so
 * the tenant is known from the path rather than guessed from the payload.
 *
 * Two responsibilities:
 *   1. Mirror call state into our own tables (analytics, transcripts, the
 *      console's call list).
 *   2. Translate the voice provider's message vocabulary into VoiceKernel events and fan them
 *      out to the customer's own endpoints.
 *
 * Some messages are synchronous: The provider blocks the live call waiting for our
 * reply. Those are answered inline and must stay fast.
 */
export const inboundWebhooksRouter = Router();

/** The provider message types that expect a response body mid-call. */
const BLOCKING_MESSAGES = new Set([
  'assistant-request',
  'tool-calls',
  'function-call',
  'transfer-destination-request',
  'knowledge-base-request',
]);

/** The provider message.type -> VoiceKernel event type. */
const EVENT_MAP: Record<string, string> = {
  'status-update': 'call.status-update',
  'end-of-call-report': 'call.ended',
  'hang': 'call.hang',
  'speech-update': 'call.speech-update',
  'transcript': 'call.transcript',
  'tool-calls': 'tool.called',
  'function-call': 'tool.called',
  'assistant-request': 'assistant.requested',
  'transfer-destination-request': 'transfer.destination.requested',
  'conversation-update': 'call.updated',
  'user-interrupted': 'call.updated',
  'model-output': 'call.updated',
  'phone-call-control': 'call.updated',
  'voice-input': 'call.updated',
};

/**
 * Verifies the shared secret the provider sends. Skipped when unset so local
 * development works, but a production deployment without it is logged loudly - * an unauthenticated webhook lets anyone forge call events for a tenant.
 */
function verifyProviderSecret(headerValue: string | undefined): boolean {
  if (!config.provider.webhookSecret) {
    if (config.isProd) {
      logger.error(
        'PROVIDER_WEBHOOK_SECRET is not set; inbound webhooks are unauthenticated. Set it in your voice provider dashboard and this deployment.',
      );
    }
    return true;
  }
  if (!headerValue) return false;
  return safeEqual(config.provider.webhookSecret, headerValue);
}

inboundWebhooksRouter.post(
  '/provider/:orgId',
  asyncHandler(async (req, res) => {
    const secretHeader =
      req.header('x-vapi-secret') ?? req.header('x-vapi-signature') ?? undefined;

    if (!verifyProviderSecret(secretHeader)) {
      logger.warn({ orgId: req.params.orgId }, 'rejected inbound webhook: bad secret');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const org = await getOrg(req.params.orgId);
    if (!org || org.status !== 'active') {
      // 200 on purpose: a retry storm from the voice provider will not fix a deleted org.
      res.status(200).json({ received: true, ignored: 'unknown organization' });
      return;
    }

    const message = (req.body?.message ?? req.body ?? {}) as Record<string, unknown>;
    const messageType = typeof message.type === 'string' ? message.type : 'unknown';
    const call = (message.call ?? req.body?.call ?? null) as Record<string, unknown> | null;

    logger.debug({ orgId: org.id, messageType, callId: call?.id }, 'inbound provider webhook');

    // ---- 1. mirror state -------------------------------------------------
    if (call && typeof call.id === 'string') {
      // The end-of-call report carries the fullest picture; merge it in.
      const merged =
        messageType === 'end-of-call-report'
          ? { ...call, ...pick(message, ['artifact', 'analysis', 'endedReason', 'cost', 'costBreakdown', 'summary', 'transcript', 'recordingUrl', 'messages']) }
          : call;
      await recordCallFromProvider(org.id, merged);
    }

    // ---- 2. answer blocking messages inline ------------------------------
    if (BLOCKING_MESSAGES.has(messageType)) {
      const reply = await handleBlockingMessage(org.id, messageType, message, req.body);
      // Fan out for observability, but never let it delay the response.
      void emitEvent({
        orgId: org.id,
        type: EVENT_MAP[messageType] ?? `provider.${messageType}`,
        resourceKind: 'call',
        resourceId: typeof call?.id === 'string' ? call.id : null,
        payload: { message, reply },
      }).catch((err) => logger.error({ err }, 'failed to emit blocking event'));

      res.status(200).json(reply);
      return;
    }

    // ---- 3. fan out ------------------------------------------------------
    const eventType = EVENT_MAP[messageType] ?? `provider.${messageType}`;

    // A status update to "in-progress" is the start of the call; give
    // integrators the distinct event they expect rather than making them
    // inspect the payload.
    const status = typeof message.status === 'string' ? message.status : null;
    const resolvedType =
      messageType === 'status-update' && status === 'in-progress' ? 'call.started' : eventType;

    await emitEvent({
      orgId: org.id,
      type: resolvedType,
      resourceKind: call ? 'call' : null,
      resourceId: typeof call?.id === 'string' ? call.id : null,
      payload: { type: messageType, ...message },
    });

    res.status(200).json({ received: true });
  }),
);

/**
 * Handles the message types the provider blocks on.
 *
 * `tool-calls` is the important one: it is how a voice agent reaches into the
 * customer's systems. The customer registers a tool whose server URL is their
 * own endpoint; the provider asks us, we ask them, and their answer becomes the agent's
 * next sentence. Returning an empty result is safe - the provider treats it as "the
 * tool produced nothing" rather than failing the call.
 */
async function handleBlockingMessage(
  orgId: string,
  messageType: string,
  message: Record<string, unknown>,
  rawBody: unknown,
): Promise<Record<string, unknown>> {
  switch (messageType) {
    case 'assistant-request': {
      // Inbound call to a number with no statically assigned assistant. If the
      // org configured a default agent, use it.
      const org = await getOrg(orgId);
      const defaultAgentId = (org?.settings as Record<string, unknown> | undefined)
        ?.defaultAgentId;

      if (typeof defaultAgentId === 'string' && defaultAgentId) {
        const owner = await resolveOwner(defaultAgentId);
        if (owner?.orgId === orgId) return { assistantId: defaultAgentId };
      }
      return {
        error:
          'No default agent is configured for this organization. Set settings.defaultAgentId, or assign an agent to the phone number.',
      };
    }

    case 'tool-calls':
    case 'function-call': {
      // the provider already forwards tool calls to the tool's own server URL when one
      // is set. Anything reaching us has no destination configured, so report
      // that clearly instead of silently returning nothing.
      const toolCalls = Array.isArray(message.toolCalls)
        ? (message.toolCalls as Array<Record<string, unknown>>)
        : [];

      return {
        results: toolCalls.map((tc) => ({
          toolCallId: tc.id ?? null,
          result:
            'This tool has no server URL configured in VoiceKernel. Set one on the tool so calls reach your system.',
        })),
      };
    }

    case 'knowledge-base-request':
      // No custom knowledge provider wired; let the provider fall back to its own.
      return {};

    case 'transfer-destination-request':
      return {
        error:
          'No transfer destination is configured. Set one on the agent, or handle transfer.destination.requested via your webhook.',
      };

    default:
      logger.warn({ messageType, orgId }, 'unhandled blocking webhook message');
      return {};
  }
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Health probe for the webhook path itself, so an operator can confirm the URL
 * registered with the provider actually resolves before a call depends on it.
 */
inboundWebhooksRouter.get(
  '/provider/:orgId',
  asyncHandler(async (req, res) => {
    const org = await queryOne<{ id: string }>(`SELECT id FROM organizations WHERE id = $1`, [
      req.params.orgId,
    ]);
    res.json({
      endpoint: `${config.publicBaseUrl}/webhooks/provider/${req.params.orgId}`,
      organizationKnown: Boolean(org),
      secretConfigured: Boolean(config.provider.webhookSecret),
      ready: Boolean(org),
    });
  }),
);
