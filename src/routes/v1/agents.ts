import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { ApiError } from '../../errors';
import { proxyToProvider } from '../../services/proxy';
import { IN_HOUSE_PROVIDER } from '../../provider/aliases';
import { listResources } from '../../services/resources';
import { listEnvelope, parsePagination, str } from '../../lib/http';
import {
  agentInputSchema,
  fromProviderAssistant,
  toProviderAssistant,
  validateAgent,
} from '../../lib/agent';
import { emitEvent } from '../../services/webhooks';

/**
 * /v1/agents - the primary object customers build against.
 *
 * Backed by provider assistants, presented through the VoiceKernel agent facade
 * (see lib/agent.ts): a flat `systemPrompt`, a swappable `model`, and a `provider`
 * escape hatch for everything else.
 */
export const agentsRouter = Router();


// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

agentsRouter.get(
  '/',
  requireScope('agents:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { limit, offset } = parsePagination(req);
    const search = str(req.query.search);

    // Served from our registry rather than the provider: it is already org-scoped, it
    // paginates properly, and it does not spend the tenant's upstream budget on
    // a table render. `?refresh=true` forces a round trip when freshness wins.
    if (str(req.query.refresh) === 'true') {
      const upstream = await proxyToProvider({
        org,
        method: 'GET',
        path: '/assistant',
        query: { limit: Math.min(limit, 100) },
      });
      const items = Array.isArray(upstream.data) ? upstream.data : [];
      res.json(
        listEnvelope(
          items.map((a) => fromProviderAssistant(a as Record<string, unknown>)),
          { limit, offset },
        ),
      );
      return;
    }

    const { items, total } = await listResources({
      orgId: org.id,
      kind: 'assistant',
      limit,
      offset,
      search,
    });

    res.json(
      listEnvelope(
        items.map((row) => fromProviderAssistant(row.snapshot as Record<string, unknown>)),
        { total, limit, offset },
      ),
    );
  }),
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

agentsRouter.post(
  '/',
  requireScope('agents:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const input = agentInputSchema.parse(req.body ?? {});

    if (!input.name) throw ApiError.badRequest('An agent needs a name.');
    if (!input.systemPrompt && !input.provider?.model) {
      throw ApiError.badRequest(
        'An agent needs a systemPrompt describing what it should do. Pass "provider.model" instead if you are supplying a raw provider model object.',
      );
    }
    validateAgent(input);

    // Sensible production defaults, overridden by anything the caller sent.
    const withDefaults = {
      ...input,
      model: input.model ?? { provider: 'openai' as const, model: 'gpt-4o' },
      voice: input.voice ?? { provider: IN_HOUSE_PROVIDER, voiceId: 'Elliot' },
      transcriber: input.transcriber ?? { provider: 'deepgram', model: 'nova-3' },
    };

    const assistant = toProviderAssistant(withDefaults, { orgId: org.id });
    const result = await proxyToProvider({
      org,
      method: 'POST',
      path: '/assistant',
      body: assistant,
      idempotencyKey: req.header('idempotency-key'),
    });

    const agent = fromProviderAssistant(result.data as Record<string, unknown>);
    if (agent?.id) {
      void emitEvent({
        orgId: org.id,
        type: 'agent.created',
        resourceKind: 'assistant',
        resourceId: String(agent.id),
        payload: { agent },
      });
    }

    res.status(201).json(agent);
  }),
);

// ---------------------------------------------------------------------------
// Retrieve
// ---------------------------------------------------------------------------

agentsRouter.get(
  '/:id',
  requireScope('agents:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'GET',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
    });
    res.json(fromProviderAssistant(result.data as Record<string, unknown>));
  }),
);

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

agentsRouter.patch(
  '/:id',
  requireScope('agents:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const input = agentInputSchema.parse(req.body ?? {});
    validateAgent(input);

    // Fetch first: the prompt lives inside model.messages, so a partial update
    // that touches either half has to be merged against the current object or
    // it would clobber the other. The GET also re-checks ownership.
    const current = await proxyToProvider({
      org,
      method: 'GET',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
    });

    const patch = toProviderAssistant(input, {
      orgId: org.id,
      existing: current.data as Record<string, unknown>,
    });

    const result = await proxyToProvider({
      org,
      method: 'PATCH',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
      body: patch,
    });

    const agent = fromProviderAssistant(result.data as Record<string, unknown>);
    void emitEvent({
      orgId: org.id,
      type: 'agent.updated',
      resourceKind: 'assistant',
      resourceId: req.params.id,
      payload: { agent },
    });

    res.json(agent);
  }),
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

agentsRouter.delete(
  '/:id',
  requireScope('agents:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    await proxyToProvider({
      org,
      method: 'DELETE',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
    });

    void emitEvent({
      orgId: org.id,
      type: 'agent.deleted',
      resourceKind: 'assistant',
      resourceId: req.params.id,
      payload: { id: req.params.id },
    });

    res.json({ id: req.params.id, object: 'agent', deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Convenience: swap the model without composing a whole patch
// ---------------------------------------------------------------------------

const swapModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

/**
 * PUT /v1/agents/:id/model - "switch this agent to Claude" in one call.
 * The equivalent PATCH requires knowing that the prompt lives under
 * `model.messages`; this endpoint preserves it for you.
 */
agentsRouter.put(
  '/:id/model',
  requireScope('agents:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const selection = swapModelSchema.parse(req.body ?? {});

    const current = await proxyToProvider({
      org,
      method: 'GET',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
    });
    const existing = current.data as Record<string, unknown>;

    validateAgent({ model: selection });

    const previousModel = (existing.model ?? {}) as Record<string, unknown>;
    const patch = {
      model: {
        ...previousModel,
        ...selection,
        // messages carry the system prompt - never dropped on a model swap.
        messages: previousModel.messages ?? [],
      },
    };

    const result = await proxyToProvider({
      org,
      method: 'PATCH',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
      body: patch,
    });

    res.json(fromProviderAssistant(result.data as Record<string, unknown>));
  }),
);

/**
 * PUT /v1/agents/:id/prompt - update instructions only, leaving the model,
 * voice and every plan untouched. This is the endpoint most customers wire to
 * their own prompt-management or change-approval workflow.
 */
agentsRouter.put(
  '/:id/prompt',
  requireScope('agents:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { systemPrompt, firstMessage } = z
      .object({
        systemPrompt: z.string().min(1).max(120_000),
        firstMessage: z.string().max(10_000).nullable().optional(),
      })
      .parse(req.body ?? {});

    const current = await proxyToProvider({
      org,
      method: 'GET',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
    });

    const patch = toProviderAssistant(
      { systemPrompt, ...(firstMessage !== undefined ? { firstMessage } : {}) },
      { orgId: org.id, existing: current.data as Record<string, unknown> },
    );

    const result = await proxyToProvider({
      org,
      method: 'PATCH',
      path: `/assistant/${encodeURIComponent(req.params.id)}`,
      body: patch,
    });

    res.json(fromProviderAssistant(result.data as Record<string, unknown>));
  }),
);
