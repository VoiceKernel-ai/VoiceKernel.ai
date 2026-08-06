import { Router } from 'express';
import { asyncHandler } from '../../middleware/context';
import { currentOrg } from '../../middleware/auth';
import { proxyToProvider } from '../../services/proxy';
import {
  LLM_PROVIDERS,
  TOOL_TYPES,
  TRANSCRIBER_PROVIDERS,
  VOICE_PROVIDERS,
} from '../../provider/catalog.generated';

/**
 * The provider matrix behind model switching.
 *
 * Generated from the voice provider's OpenAPI document (scripts/gen-provider-catalog.ts), so the
 * options offered here are exactly what the upstream accepts - the console can
 * render a model picker without a hand-maintained list going stale.
 */
export const catalogRouter = Router();


catalogRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({
      object: 'catalog',
      models: LLM_PROVIDERS,
      voices: VOICE_PROVIDERS,
      transcribers: TRANSCRIBER_PROVIDERS,
      counts: {
        modelProviders: LLM_PROVIDERS.length,
        voiceProviders: VOICE_PROVIDERS.length,
        transcriberProviders: TRANSCRIBER_PROVIDERS.length,
        models: LLM_PROVIDERS.reduce((n, p) => n + p.options.length, 0),
      },
    });
  }),
);

/**
 * The action (tool) types an agent can call, grouped for the console library:
 * what the platform does natively on the line, what reaches into the customer's
 * own systems, and what connects a third party.
 */
catalogRouter.get(
  '/actions',
  asyncHandler(async (_req, res) => {
    const groups: Record<string, typeof TOOL_TYPES[number][]> = {};
    for (const tool of TOOL_TYPES) {
      (groups[tool.group] ??= []).push(tool);
    }

    res.json({
      object: 'list',
      total: TOOL_TYPES.length,
      groups: Object.entries(groups).map(([group, tools]) => ({
        group,
        tools,
      })),
      data: TOOL_TYPES,
    });
  }),
);

catalogRouter.get(
  '/models',
  asyncHandler(async (_req, res) => {
    res.json({ object: 'list', data: LLM_PROVIDERS });
  }),
);

catalogRouter.get(
  '/voices',
  asyncHandler(async (_req, res) => {
    res.json({ object: 'list', data: VOICE_PROVIDERS });
  }),
);

catalogRouter.get(
  '/transcribers',
  asyncHandler(async (_req, res) => {
    res.json({ object: 'list', data: TRANSCRIBER_PROVIDERS });
  }),
);

/**
 * Live voice library for a provider, e.g. the tenant's own ElevenLabs voices.
 * Proxied because the answer depends on the credential, not the spec.
 */
catalogRouter.get(
  '/voices/:provider/library',
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'GET',
      path: `/provider/${encodeURIComponent(req.params.provider)}/voice`,
      query: req.query as Record<string, unknown>,
    });
    res.status(result.status).json(result.data);
  }),
);
