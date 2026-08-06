import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { ApiError } from '../../errors';
import { proxyToProvider } from '../../services/proxy';
import { getCall, listCalls, publicCall, recordCallFromProvider } from '../../services/calls';
import { listEnvelope, parsePagination, parseDate, str } from '../../lib/http';
import { agentInputSchema, toProviderAssistant, validateAgent } from '../../lib/agent';

export const callsRouter = Router();

/**
 * Placing a call.
 *
 * The shape is deliberately flatter than the voice provider's: `to` instead of
 * `customer.number`, `agentId` instead of `assistantId`, and an inline `agent`
 * for one-off configurations that should not become a saved assistant.
 */
const createCallSchema = z
  .object({
    /** Destination in E.164, e.g. "+61400000000". */
    to: z.string().regex(/^\+[1-9]\d{6,14}$/, 'to must be an E.164 number, e.g. +61400000000').optional(),
    from: z.string().optional(),
    phoneNumberId: z.string().min(1, 'phoneNumberId cannot be empty').optional(),

    agentId: z.string().min(1, 'agentId cannot be empty').optional(),
    squadId: z.string().min(1, 'squadId cannot be empty').optional(),
    workflowId: z.string().min(1, 'workflowId cannot be empty').optional(),

    /** Inline, transient agent config - not persisted as an assistant. */
    agent: agentInputSchema.optional(),

    name: z.string().max(200).optional(),
    customer: z.record(z.unknown()).optional(),
    schedulePlan: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    assistantOverrides: z.record(z.unknown()).optional(),

    /** Escape hatch merged over the generated provider call object. */
    provider: z.record(z.unknown()).optional(),
  })
  .strict();

callsRouter.post(
  '/',
  requireScope('calls:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const input = createCallSchema.parse(req.body ?? {});

    if (!input.agentId && !input.squadId && !input.workflowId && !input.agent && !input.provider) {
      throw ApiError.badRequest(
        'Specify who should take the call: pass agentId, squadId, workflowId, or an inline agent object.',
      );
    }
    if (input.agent) validateAgent(input.agent);

    const body: Record<string, unknown> = {};

    if (input.name) body.name = input.name;
    if (input.agentId) body.assistantId = input.agentId;
    if (input.squadId) body.squadId = input.squadId;
    if (input.workflowId) body.workflowId = input.workflowId;
    if (input.phoneNumberId) body.phoneNumberId = input.phoneNumberId;
    if (input.assistantOverrides) body.assistantOverrides = input.assistantOverrides;
    if (input.schedulePlan) body.schedulePlan = input.schedulePlan;
    if (input.metadata) body.metadata = input.metadata;

    if (input.agent) {
      body.assistant = toProviderAssistant(input.agent, { orgId: org.id });
    }

    // `to` is the friendly form of the voice provider's customer object; an explicit
    // `customer` wins so advanced callers keep full control.
    if (input.customer) {
      body.customer = input.customer;
    } else if (input.to) {
      body.customer = { number: input.to };
    }

    if (input.provider) Object.assign(body, input.provider);

    const result = await proxyToProvider({
      org,
      method: 'POST',
      path: '/call',
      body,
      idempotencyKey: req.header('idempotency-key'),
    });

    res.status(201).json(result.data);
  }),
);

/**
 * Starting a call from the browser.
 *
 * This is the "talk to it" path: an operator opens an agent in the console and
 * speaks to it to hear what it actually does, without dialling a phone number
 * or spending a telephony minute.
 *
 * It is a separate route rather than a flag on POST /v1/calls because almost
 * nothing is shared. There is no destination number, no phone number id and no
 * schedule; what comes back is not a call receipt but a room the browser has
 * to join, and a caller who does not get that URL has nothing. Folding it into
 * the phone-call schema would make half of that schema conditional on a flag.
 *
 * The media transport is WebRTC. We ask the upstream for a web call and hand
 * the room URL to the browser, which connects directly - audio never transits
 * VoiceKernel, so there is no relay to scale and no place for us to hold a
 * recording we were not asked to hold.
 */
const webCallSchema = z
  .object({
    agentId: z.string().min(1, 'agentId cannot be empty').optional(),
    squadId: z.string().min(1, 'squadId cannot be empty').optional(),
    workflowId: z.string().min(1, 'workflowId cannot be empty').optional(),
    /** Inline, transient agent config - lets the console test unsaved edits. */
    agent: agentInputSchema.optional(),
    assistantOverrides: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

callsRouter.post(
  '/web',
  requireScope('calls:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const input = webCallSchema.parse(req.body ?? {});

    if (!input.agentId && !input.squadId && !input.workflowId && !input.agent) {
      throw ApiError.badRequest(
        'Specify who should take the call: pass agentId, squadId, workflowId, or an inline agent object.',
      );
    }
    if (input.agent) validateAgent(input.agent);

    // No transport field: the endpoint itself is what makes this a browser
    // call. Declaring `transport: { provider: 'daily' }` on POST /call looks
    // right against the spec and is not - the upstream reads it as telephony
    // and rejects the call for having no phone number.
    const body: Record<string, unknown> = {};

    if (input.agentId) body.assistantId = input.agentId;
    if (input.squadId) body.squadId = input.squadId;
    if (input.workflowId) body.workflowId = input.workflowId;
    if (input.agent) body.assistant = toProviderAssistant(input.agent, { orgId: org.id });
    if (input.assistantOverrides) body.assistantOverrides = input.assistantOverrides;
    if (input.metadata) body.metadata = input.metadata;

    const result = await proxyToProvider({
      org,
      method: 'POST',
      path: '/call/web',
      credential: 'public',
      body,
      idempotencyKey: req.header('idempotency-key'),
    });

    const call = (result.data ?? {}) as Record<string, unknown>;
    const roomUrl = webCallUrl(call);

    if (!roomUrl) {
      // The call may well have been created upstream, but without a room the
      // browser cannot join it and the operator is left with a call they can
      // neither hear nor stop. Say so instead of returning a 201 that looks
      // like success.
      throw new ApiError(
        502,
        'web_call_unavailable',
        'The call was created but the provider returned no room to join, so it cannot be answered from the browser. This usually means web calls are not enabled for this provider account.',
      );
    }

    res.status(201).json({
      object: 'call.web',
      id: typeof call.id === 'string' ? call.id : null,
      callUrl: roomUrl,
      status: typeof call.status === 'string' ? call.status : null,
    });
  }),
);

/**
 * Digs the room URL out of a created call.
 *
 * The field sits under `transport` in the spec, but responses have been seen
 * carrying it at the top level too, so both are accepted. Anything else - a
 * telephony transport, a missing transport - yields null and the caller turns
 * that into an explicit error rather than a broken join.
 */
function webCallUrl(call: Record<string, unknown>): string | null {
  const transport = call.transport;
  if (transport && typeof transport === 'object') {
    const url = (transport as Record<string, unknown>).callUrl;
    if (typeof url === 'string' && url.startsWith('https://')) return url;
  }
  const flat = call.webCallUrl;
  if (typeof flat === 'string' && flat.startsWith('https://')) return flat;
  return null;
}

/**
 * List calls from VoiceKernel's own mirror.
 *
 * This is the only correct source in platform mode - the voice provider's /call list spans
 * the whole shared account. It is also richer: transcripts and analysis are
 * already denormalised, and filtering by them upstream is not possible.
 */
callsRouter.get(
  '/',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { limit, offset } = parsePagination(req);

    const { items, total } = await listCalls({
      orgId: org.id,
      limit,
      offset,
      status: str(req.query.status),
      assistantId: str(req.query.agentId) ?? str(req.query.assistantId),
      direction: str(req.query.direction),
      since: req.query.since ? parseDate(req.query.since, new Date(0)) : undefined,
      until: req.query.until ? parseDate(req.query.until, new Date()) : undefined,
      search: str(req.query.search),
    });

    res.json(listEnvelope(items.map(publicCall), { total, limit, offset }));
  }),
);

callsRouter.get(
  '/:id',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    // Live calls change second to second, so go upstream by default and fall
    // back to the mirror only if the provider has already aged the record out.
    if (str(req.query.cached) !== 'true') {
      try {
        const result = await proxyToProvider({
          org,
          method: 'GET',
          path: `/call/${encodeURIComponent(req.params.id)}`,
        });
        await recordCallFromProvider(org.id, result.data);
        res.json(result.data);
        return;
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
    }

    const row = await getCall(org.id, req.params.id);
    if (!row) throw ApiError.notFound(`No call with id '${req.params.id}' in this organization.`);
    res.json(publicCall(row));
  }),
);

callsRouter.patch(
  '/:id',
  requireScope('calls:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'PATCH',
      path: `/call/${encodeURIComponent(req.params.id)}`,
      body: req.body,
    });
    res.json(result.data);
  }),
);

/** Ends a live call, or deletes the stored call data once it has finished. */
callsRouter.delete(
  '/:id',
  requireScope('calls:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'DELETE',
      path: `/call/${encodeURIComponent(req.params.id)}`,
    });
    res.json(
      result.data && typeof result.data === 'object'
        ? result.data
        : { id: req.params.id, deleted: true },
    );
  }),
);

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const ARTIFACTS = {
  recording: 'mono-recording',
  'mono-recording': 'mono-recording',
  'stereo-recording': 'stereo-recording',
  'video-recording': 'video-recording',
  'customer-recording': 'customer-recording',
  'assistant-recording': 'assistant-recording',
  pcap: 'pcap',
  logs: 'call-logs',
} as const;

/**
 * Returns a short-lived presigned URL for a call artifact rather than
 * streaming the bytes. Audio is large and the caller usually wants to hand the
 * URL to a browser or storage pipeline anyway.
 */
callsRouter.get(
  '/:id/artifacts/:artifact',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const requested = req.params.artifact as keyof typeof ARTIFACTS;
    const upstreamName = ARTIFACTS[requested];

    if (!upstreamName) {
      throw ApiError.badRequest(
        `Unknown artifact '${req.params.artifact}'. Available: ${Object.keys(ARTIFACTS).join(', ')}.`,
      );
    }

    const result = await proxyToProvider({
      org,
      method: 'GET',
      path: `/call/${encodeURIComponent(req.params.id)}/${upstreamName}`,
    });
    res.json(result.data);
  }),
);

/** Convenience: the transcript from our mirror, no upstream round trip. */
callsRouter.get(
  '/:id/transcript',
  requireScope('calls:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const row = await getCall(org.id, req.params.id);
    if (!row) throw ApiError.notFound(`No call with id '${req.params.id}' in this organization.`);

    res.json({
      callId: row.provider_call_id,
      transcript: row.transcript,
      summary: row.summary,
      analysis: row.analysis,
      messages: (row.raw as Record<string, unknown>)?.messages ?? [],
    });
  }),
);
