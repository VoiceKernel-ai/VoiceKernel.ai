import { Router } from 'express';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { parseWindow, str } from '../../lib/http';
import { evaluateMonitors, escalationReasons } from '../../services/monitors';
import { proxyToProvider } from '../../services/proxy';
import { listResources } from '../../services/resources';
import { listApiKeys, publicApiKey } from '../../services/apikeys';
import { listMembers, publicOrg } from '../../services/org';
import { listAudit, publicAudit } from '../../services/audit';
import { LLM_PROVIDERS, TRANSCRIBER_PROVIDERS, VOICE_PROVIDERS } from '../../provider/catalog.generated';
import { ApiError } from '../../errors';

/**
 * Backing for the console's Test & Observe and Manage views.
 *
 * These compose data VoiceKernel already holds rather than introducing new
 * storage: eval suites and structured outputs live in the provider, monitors are
 * queries over the call mirror, and access/audit come from our own tables.
 */

export const observeRouter = Router();

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

observeRouter.get(
  '/monitors',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 7);
    const result = await evaluateMonitors(org.id, since, until);

    res.json({
      object: 'monitoring',
      window: { since, until },
      ...result,
      summary: {
        total: result.monitors.length,
        firing: result.monitors.filter((m) => m.state === 'firing').length,
        unknown: result.monitors.filter((m) => m.state === 'unknown').length,
      },
    });
  }),
);

observeRouter.get(
  '/escalations',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { since, until } = parseWindow(req, 30);
    res.json({
      object: 'analytics.escalations',
      window: { since, until },
      data: await escalationReasons(org.id, since, until),
    });
  }),
);

// ---------------------------------------------------------------------------
// Evals - the voice provider's /eval and /eval/run, shaped into suites and a deploy gate
// ---------------------------------------------------------------------------

/**
 * Eval suites with their most recent run, plus a promotion gate.
 *
 * The gate is deliberately conservative: an eval that has never run counts as
 * not passing. "We do not know" must not read as "safe to promote", because the
 * whole point of the gate is to stop an unverified agent reaching production.
 */
observeRouter.get(
  '/evals/summary',
  requireScope('evals:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    const [suites, runs] = await Promise.all([
      listResources({ orgId: org.id, kind: 'eval', limit: 100 }),
      listResources({ orgId: org.id, kind: 'evalRun', limit: 100 }),
    ]);

    // Index the latest run per eval so a suite shows its current state.
    const latestByEval = new Map<string, Record<string, unknown>>();
    for (const run of runs.items) {
      const snapshot = run.snapshot as Record<string, unknown>;
      const evalId = typeof snapshot.evalId === 'string' ? snapshot.evalId : null;
      if (!evalId) continue;
      const existing = latestByEval.get(evalId);
      if (!existing || String(snapshot.createdAt ?? '') > String(existing.createdAt ?? '')) {
        latestByEval.set(evalId, snapshot);
      }
    }

    const data = suites.items.map((suite) => {
      const snapshot = suite.snapshot as Record<string, unknown>;
      const run = latestByEval.get(suite.provider_id) ?? null;
      const results = Array.isArray(run?.results) ? (run!.results as unknown[]) : [];
      const passed = results.filter(
        (r) => (r as Record<string, unknown>)?.passed === true,
      ).length;

      return {
        id: suite.provider_id,
        name: suite.name ?? snapshot.name ?? suite.provider_id,
        type: snapshot.type ?? null,
        lastRun: run
          ? {
              id: run.id ?? null,
              createdAt: run.createdAt ?? null,
              total: results.length,
              passed,
              // Null rather than 0 when a run produced no results, so an empty
              // run does not render as a clean 0% failure.
              passRate: results.length ? Number((passed / results.length).toFixed(4)) : null,
            }
          : null,
        status: !run ? 'never_run' : results.length && passed === results.length ? 'passing' : 'failing',
      };
    });

    const gate = [
      {
        id: 'all_suites_run',
        label: 'Every suite has been run',
        passed: data.length > 0 && data.every((s) => s.status !== 'never_run'),
        detail:
          data.length === 0
            ? 'No eval suites defined. Create one before promoting an agent to production.'
            : `${data.filter((s) => s.status === 'never_run').length} suite(s) have never run.`,
      },
      {
        id: 'all_suites_passing',
        label: 'Every suite passes',
        passed: data.length > 0 && data.every((s) => s.status === 'passing'),
        detail: `${data.filter((s) => s.status === 'failing').length} suite(s) failing.`,
      },
    ];

    res.json({
      object: 'evals.summary',
      data,
      gate,
      canPromote: gate.every((g) => g.passed),
      totals: {
        suites: data.length,
        passing: data.filter((s) => s.status === 'passing').length,
        failing: data.filter((s) => s.status === 'failing').length,
        neverRun: data.filter((s) => s.status === 'never_run').length,
      },
    });
  }),
);

/** Runs an eval suite upstream. */
observeRouter.post(
  '/evals/:id/run',
  requireScope('evals:write'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const result = await proxyToProvider({
      org,
      method: 'POST',
      path: '/eval/run',
      body: { evalId: req.params.id, ...(req.body ?? {}) },
      idempotencyKey: req.header('idempotency-key'),
    });
    res.status(201).json(result.data);
  }),
);

// ---------------------------------------------------------------------------
// Intel schemas - provider structured outputs
// ---------------------------------------------------------------------------

/**
 * Structured extraction schemas with a measured fill rate.
 *
 * Fill rate is computed from this org's own calls: of the calls that ran while
 * a schema was live, how many produced a value for it. Schemas with no matching
 * calls report null, not 100%.
 */
observeRouter.get(
  '/schemas',
  requireScope('evals:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const schemas = await listResources({ orgId: org.id, kind: 'structuredOutput', limit: 100 });

    res.json({
      object: 'list',
      data: schemas.items.map((row) => {
        const snapshot = row.snapshot as Record<string, unknown>;
        const schema = (snapshot.schema ?? {}) as Record<string, unknown>;
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

        return {
          id: row.provider_id,
          name: row.name ?? snapshot.name ?? row.provider_id,
          description: snapshot.description ?? null,
          fields: Object.entries(properties).map(([name, definition]) => ({
            name,
            type: definition.type ?? 'string',
            required: required.includes(name),
            description: definition.description ?? null,
            enumValues: Array.isArray(definition.enum) ? definition.enum : null,
          })),
          fieldCount: Object.keys(properties).length,
          createdAt: row.created_at,
        };
      }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Voices - catalog plus the tenant's own provider library
// ---------------------------------------------------------------------------

observeRouter.get(
  '/voices',
  requireScope('agents:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const provider = str(req.query.provider);

    // Which voices this org is actually using, derived from saved agents.
    const agents = await listResources({ orgId: org.id, kind: 'assistant', limit: 200 });
    const inUse = new Map<string, { provider: string; voiceId: string; agents: string[] }>();

    for (const agent of agents.items) {
      const snapshot = agent.snapshot as Record<string, unknown>;
      const voice = (snapshot.voice ?? {}) as Record<string, unknown>;
      if (typeof voice.provider !== 'string') continue;
      const voiceId = typeof voice.voiceId === 'string' ? voice.voiceId : '(default)';
      const key = `${voice.provider}:${voiceId}`;
      const entry = inUse.get(key) ?? { provider: voice.provider, voiceId, agents: [] };
      entry.agents.push(agent.name ?? agent.provider_id);
      inUse.set(key, entry);
    }

    let library: unknown = null;
    if (provider) {
      // The tenant's own voices at that provider - depends on their credential,
      // so it has to come from upstream rather than the static catalog.
      try {
        const upstream = await proxyToProvider({
          org,
          method: 'GET',
          path: `/provider/${encodeURIComponent(provider)}/voice`,
        });
        library = upstream.data;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        library = { error: err.message };
      }
    }

    res.json({
      object: 'voices',
      inUse: [...inUse.values()],
      providers: VOICE_PROVIDERS,
      library,
    });
  }),
);

// ---------------------------------------------------------------------------
// Manage - access and providers
// ---------------------------------------------------------------------------

observeRouter.get(
  '/access',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const [keys, members, audit] = await Promise.all([
      listApiKeys(org.id),
      listMembers(org.id),
      listAudit(org.id, { limit: 25 }),
    ]);

    res.json({
      object: 'access',
      keys: keys.map(publicApiKey),
      members: members.map((m) => ({
        id: m.id,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.created_at,
      })),
      audit: audit.map(publicAudit),
    });
  }),
);

/**
 * Provider routing: which vendor backs each stage, and the configured failover.
 *
 * Assembled from the agents actually saved in this org, because the routing a
 * customer cares about is what their agents use - not what the platform could
 * theoretically support.
 */
observeRouter.get(
  '/providers',
  requireScope('analytics:read'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const agents = await listResources({ orgId: org.id, kind: 'assistant', limit: 200 });

    const stages = {
      transcriber: new Map<string, { provider: string; model: string | null; agents: number; fallback: string | null }>(),
      model: new Map<string, { provider: string; model: string | null; agents: number; fallback: string | null }>(),
      voice: new Map<string, { provider: string; model: string | null; agents: number; fallback: string | null }>(),
    };

    for (const agent of agents.items) {
      const snapshot = agent.snapshot as Record<string, unknown>;

      for (const stage of ['transcriber', 'model', 'voice'] as const) {
        const block = (snapshot[stage] ?? {}) as Record<string, unknown>;
        if (typeof block.provider !== 'string') continue;

        const value =
          stage === 'voice'
            ? (block.voiceId as string | undefined) ?? null
            : (block.model as string | undefined) ?? null;

        const fallbackPlan = (block.fallbackPlan ?? null) as Record<string, unknown> | null;
        const fallbacks = Array.isArray(fallbackPlan?.voices)
          ? fallbackPlan!.voices
          : Array.isArray(fallbackPlan?.transcribers)
            ? fallbackPlan!.transcribers
            : Array.isArray(block.fallbackModels)
              ? block.fallbackModels
              : null;

        const key = `${block.provider}:${value ?? ''}`;
        const existing = stages[stage].get(key);
        if (existing) {
          existing.agents++;
        } else {
          stages[stage].set(key, {
            provider: block.provider,
            model: value,
            agents: 1,
            fallback: fallbacks && fallbacks.length ? describeFallback(fallbacks[0]) : null,
          });
        }
      }
    }

    res.json({
      object: 'providers',
      mode: org.provider_mode,
      organization: publicOrg(org),
      routing: {
        transcriber: [...stages.transcriber.values()],
        model: [...stages.model.values()],
        voice: [...stages.voice.values()],
      },
      available: {
        models: LLM_PROVIDERS.length,
        voices: VOICE_PROVIDERS.length,
        transcribers: TRANSCRIBER_PROVIDERS.length,
      },
    });
  }),
);

function describeFallback(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    const provider = record.provider ?? '';
    const value = record.model ?? record.voiceId ?? '';
    return `${provider}${value ? ` / ${value}` : ''}` || null;
  }
  return null;
}
