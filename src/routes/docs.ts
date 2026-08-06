import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import { config } from '../config';
import { PROVIDER_OPERATIONS, PROVIDER_OPERATION_COUNT } from '../provider/operations.generated';
import { POLICY_BY_OPERATION } from '../provider/resources';
import { RESOURCE_ROUTES } from './v1/generic';
import { AVAILABLE_SCOPES } from '../services/apikeys';
import { EVENT_TYPES } from '../services/webhooks';
import {
  LLM_PROVIDERS,
  TRANSCRIBER_PROVIDERS,
  VOICE_PROVIDERS,
} from '../provider/catalog.generated';

/**
 * Machine-readable description of this deployment.
 *
 * Unauthenticated on purpose: an integrator evaluating VoiceKernel should be
 * able to see the surface, the provider matrix and the event vocabulary before
 * they have credentials. Nothing tenant-specific is exposed.
 */
export const docsRouter = Router();

/**
 * Locates the generated documentation page, if it has been built.
 * Same dual-layout probe as the web root: source vs compiled `__dirname`.
 */
function docsPagePath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../web/docs.html'), // src/routes/docs.ts
    path.resolve(__dirname, '../../../web/docs.html'), // dist/src/routes/docs.js
    path.resolve(process.cwd(), 'web/docs.html'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * `/docs` answers HTML to browsers and JSON to machines.
 *
 * Both audiences ask for the same URL: a developer pastes it into a browser and
 * expects the reference page, while an SDK or a script wants the machine
 * description. Serving only JSON - which is what this did - meant the link in
 * every marketing page's nav rendered as a wall of braces.
 *
 * The edge Worker serves the same static page for this path, so development and
 * production now agree rather than diverging on which one you hit.
 */
docsRouter.get('/', (req, res, next) => {
  const wantsHtml = req.accepts(['html', 'json']) === 'html';
  if (wantsHtml) {
    const page = docsPagePath();
    if (page) {
      res.sendFile(page);
      return;
    }
    // Not built yet (npm run gen:docs) - fall through to JSON rather than 404.
  }
  next();
});

docsRouter.get('/', (_req, res) => {
  const nativeRoutes = [
    { path: '/v1/agents', description: 'Voice agents - prompt, model, voice, tools.' },
    { path: '/v1/calls', description: 'Place, inspect, and end calls; transcripts and recordings.' },
    { path: '/v1/analytics', description: 'Org-scoped call volume, containment, cost, latency.' },
    { path: '/v1/catalog', description: 'Supported LLM, voice and transcriber providers.' },
    { path: '/v1/webhook-endpoints', description: 'Signed event delivery into your systems.' },
    { path: '/v1/events', description: 'Event history and the audit trail.' },
    { path: '/v1/api-keys', description: 'Credential management.' },
    { path: '/v1/organization', description: 'Tenant settings and voice provider mode.' },
    ...RESOURCE_ROUTES.map((r) => ({
      path: `/v1/${r.segment}`,
      description: `CRUD for ${r.label}s.`,
    })),
    {
      path: '/v1/provider/*',
      description: `Mediated passthrough covering all ${PROVIDER_OPERATION_COUNT} provider operations.`,
    },
  ];

  res.json({
    service: 'VoiceKernel',
    version: '1.0.0',
    description: 'The voice infrastructure layer for regulated enterprise.',
    baseUrl: config.publicBaseUrl,
    authentication: {
      apiKey: 'Authorization: Bearer vk_live_… (or X-API-Key)',
      session: 'POST /auth/login for the console; httpOnly cookies.',
      scopes: AVAILABLE_SCOPES,
    },
    conventions: {
      errors: '{ "error": { "type", "code", "message", "requestId" } }',
      pagination: '?limit=&offset= - responses carry { data, pagination }.',
      idempotency: 'Send Idempotency-Key on POST/PATCH to make retries safe.',
      rateLimit: `${config.rateLimit.max} requests / ${config.rateLimit.windowMs / 1000}s per credential.`,
    },
    routes: nativeRoutes,
    sdks: {
      typescript: {
        package: '@voicekernel/sdk',
        status: 'available',
        install: 'npm install @voicekernel/sdk',
        source: 'packages/sdk-typescript',
        example:
          "import { VoiceKernel } from '@voicekernel/sdk';\n" +
          "const vk = new VoiceKernel({ apiKey: process.env.VK_API_KEY });\n" +
          "const agent = await vk.agents.create({\n" +
          "  name: 'Card disputes',\n" +
          "  systemPrompt: 'You are a card disputes specialist…',\n" +
          "  model: { provider: 'anthropic', model: 'claude-sonnet-5' },\n" +
          "});\n" +
          "await vk.calls.create({ to: '+61400000000', agentId: agent.id });",
        features: [
          'Typed resources for agents, calls, analytics, catalog, webhooks, billing and erasure',
          'Automatic idempotency keys on call placement, so a retried timeout never places a second call',
          'Retries with exponential backoff on transient failures; unkeyed POSTs are never replayed',
          'Async iterators for paginated collections',
          'Webhook signature verification with replay protection',
          'provider() escape hatch to every upstream operation',
        ],
      },
      // Named plainly rather than listed as "coming soon" next to a shipped one.
      python: { status: 'not_yet_available' },
      go: { status: 'not_yet_available' },
      openapi: {
        status: 'available',
        url: `${config.publicBaseUrl}/docs/openapi.json`,
        note: 'Generate a client for any other language from the OpenAPI document.',
      },
    },
    webhooks: {
      events: EVENT_TYPES,
      signature:
        'X-VoiceKernel-Signature: t=<unix>,v1=<hex hmac_sha256("<t>.<rawBody>")>; reject if |now - t| > 300s.',
      retries: `${config.webhooks.maxAttempts} attempts with exponential backoff.`,
    },
    providers: {
      models: LLM_PROVIDERS.length,
      voices: VOICE_PROVIDERS.length,
      transcribers: TRANSCRIBER_PROVIDERS.length,
    },
    upstream: {
      operationsCovered: PROVIDER_OPERATION_COUNT,
      note: 'Every upstream operation is reachable through /v1/provider/*.',
    },
  });
});

/** The full upstream operation map, including how each is mediated. */
docsRouter.get('/operations', (_req, res) => {
  res.json({
    object: 'list',
    total: PROVIDER_OPERATION_COUNT,
    data: PROVIDER_OPERATIONS.map((e) => {
      const policy = POLICY_BY_OPERATION.get(e.operationId);
      return {
        operationId: e.operationId,
        method: e.method,
        path: `/v1/provider${e.path}`,
        upstreamPath: e.path,
        tag: e.tag,
        summary: e.summary,
        resourceKind: policy?.kind ?? null,
        isolation: policy?.scope ?? 'tenant',
      };
    }),
  });
});

/** OpenAPI 3.1 for the VoiceKernel-native surface. */
docsRouter.get('/openapi.json', (_req, res) => {
  res.json(buildOpenApiDocument());
});

export function buildOpenApiDocument(): Record<string, unknown> {
  const errorSchema = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string' },
        },
      },
    },
  };

  const paths: Record<string, unknown> = {
    '/v1/agents': {
      get: {
        tags: ['Agents'],
        summary: 'List agents',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          {
            name: 'refresh',
            in: 'query',
            schema: { type: 'boolean' },
            description: 'Bypass the local snapshot and read through to the voice provider.',
          },
        ],
        responses: { '200': { description: 'A list of agents.' } },
      },
      post: {
        tags: ['Agents'],
        summary: 'Create an agent',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentInput' },
              example: {
                name: 'Card disputes',
                systemPrompt:
                  'You are a card disputes specialist for a retail bank. Answer only from the supplied policy documents. If unsure, escalate to a human.',
                firstMessage: 'Thanks for calling - how can I help with your card today?',
                model: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.3 },
                voice: { provider: '11labs', voiceId: 'matilda' },
                transcriber: { provider: 'deepgram', model: 'nova-3' },
              },
            },
          },
        },
        responses: { '201': { description: 'The created agent.' } },
      },
    },
    '/v1/agents/{id}': {
      get: { tags: ['Agents'], summary: 'Retrieve an agent', responses: { '200': { description: 'The agent.' } } },
      patch: { tags: ['Agents'], summary: 'Update an agent', responses: { '200': { description: 'The updated agent.' } } },
      delete: { tags: ['Agents'], summary: 'Delete an agent', responses: { '200': { description: 'Deleted.' } } },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    },
    '/v1/agents/{id}/model': {
      put: {
        tags: ['Agents'],
        summary: 'Swap the agent model, preserving its prompt',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.3 },
            },
          },
        },
        responses: { '200': { description: 'The updated agent.' } },
      },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    },
    '/v1/agents/{id}/prompt': {
      put: {
        tags: ['Agents'],
        summary: 'Update the agent prompt only',
        requestBody: {
          required: true,
          content: { 'application/json': { example: { systemPrompt: 'You are…' } } },
        },
        responses: { '200': { description: 'The updated agent.' } },
      },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    },
    '/v1/calls': {
      get: { tags: ['Calls'], summary: 'List calls', responses: { '200': { description: 'A list of calls.' } } },
      post: {
        tags: ['Calls'],
        summary: 'Place a call',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: {
                to: '+61400000000',
                agentId: 'asst_123',
                phoneNumberId: 'pn_456',
                metadata: { crmTicket: 'INC-9912' },
              },
            },
          },
        },
        responses: { '201': { description: 'The created call.' } },
      },
    },
    '/v1/calls/{id}': {
      get: { tags: ['Calls'], summary: 'Retrieve a call', responses: { '200': { description: 'The call.' } } },
      delete: { tags: ['Calls'], summary: 'End a call or delete its data', responses: { '200': { description: 'Deleted.' } } },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    },
    '/v1/calls/{id}/transcript': {
      get: { tags: ['Calls'], summary: 'Transcript, summary and analysis', responses: { '200': { description: 'The transcript.' } } },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    },
    '/v1/calls/{id}/artifacts/{artifact}': {
      get: {
        tags: ['Calls'],
        summary: 'Presigned URL for a recording, pcap or call log',
        responses: { '200': { description: '{ url, expiresIn, artifact }' } },
      },
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'artifact',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: ['recording', 'mono-recording', 'stereo-recording', 'video-recording', 'customer-recording', 'assistant-recording', 'pcap', 'logs'],
          },
        },
      ],
    },
    '/v1/analytics/overview': {
      get: { tags: ['Analytics'], summary: 'Volume, containment, cost and latency', responses: { '200': { description: 'Metrics.' } } },
    },
    '/v1/catalog': {
      get: { tags: ['Catalog'], summary: 'Supported model, voice and transcriber providers', responses: { '200': { description: 'The catalog.' } } },
    },
    '/v1/webhook-endpoints': {
      get: { tags: ['Webhooks'], summary: 'List webhook endpoints', responses: { '200': { description: 'A list.' } } },
      post: {
        tags: ['Webhooks'],
        summary: 'Register a webhook endpoint',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { url: 'https://crm.example.com/hooks/voicekernel', events: ['call.ended', 'tool.called'] },
            },
          },
        },
        responses: { '201': { description: 'The endpoint, including its signing secret.' } },
      },
    },
    '/v1/provider/{path}': {
      get: {
        tags: ['Provider passthrough'],
        summary: `Mediated access to any of the ${PROVIDER_OPERATION_COUNT} provider operations`,
        description:
          'Same auth, tenant isolation, rate limiting and audit as native routes. GET /v1/provider/_operations lists everything reachable.',
        responses: { '200': { description: 'The upstream response.' } },
      },
      parameters: [
        {
          name: 'path',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          description: 'Provider path, e.g. "assistant" or "call/abc123".',
        },
      ],
    },
  };

  for (const cfg of RESOURCE_ROUTES) {
    paths[`/v1/${cfg.segment}`] = {
      get: { tags: [cfg.label], summary: `List ${cfg.label}s`, responses: { '200': { description: 'A list.' } } },
      post: { tags: [cfg.label], summary: `Create a ${cfg.label}`, responses: { '201': { description: 'Created.' } } },
    };
    paths[`/v1/${cfg.segment}/{id}`] = {
      get: { tags: [cfg.label], summary: `Retrieve a ${cfg.label}`, responses: { '200': { description: 'The object.' } } },
      patch: { tags: [cfg.label], summary: `Update a ${cfg.label}`, responses: { '200': { description: 'Updated.' } } },
      delete: { tags: [cfg.label], summary: `Delete a ${cfg.label}`, responses: { '200': { description: 'Deleted.' } } },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'VoiceKernel API',
      version: '1.0.0',
      description:
        'The voice infrastructure layer for regulated enterprise. Create agents, place calls, ground answers in your knowledge, and stream every event into your own systems.',
    },
    servers: [{ url: config.publicBaseUrl }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Agents' },
      { name: 'Calls' },
      { name: 'Analytics' },
      { name: 'Catalog' },
      { name: 'Webhooks' },
      { name: 'Provider passthrough' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'vk_live_…' },
      },
      schemas: {
        Error: errorSchema,
        AgentInput: {
          type: 'object',
          required: ['name', 'systemPrompt'],
          properties: {
            name: { type: 'string' },
            systemPrompt: { type: 'string', description: "The agent's instructions." },
            firstMessage: { type: 'string', nullable: true },
            model: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: LLM_PROVIDERS.map((p) => p.provider) },
                model: { type: 'string' },
                temperature: { type: 'number' },
                maxTokens: { type: 'integer' },
                toolIds: { type: 'array', items: { type: 'string' } },
                knowledgeBaseId: { type: 'string' },
              },
            },
            voice: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: VOICE_PROVIDERS.map((p) => p.provider) },
                voiceId: { type: 'string' },
              },
            },
            transcriber: {
              type: 'object',
              properties: {
                provider: { type: 'string', enum: TRANSCRIBER_PROVIDERS.map((p) => p.provider) },
                model: { type: 'string' },
                language: { type: 'string' },
              },
            },
            server: {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri' }, secret: { type: 'string' } },
            },
            metadata: { type: 'object', additionalProperties: true },
            provider: {
              type: 'object',
              additionalProperties: true,
              description: 'Escape hatch merged over the generated provider assistants.',
            },
          },
        },
      },
    },
  };
}
