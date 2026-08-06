import { Router } from 'express';
import { asyncHandler } from '../../middleware/context';
import { currentOrg, requireScope } from '../../middleware/auth';
import { proxyToProvider } from '../../services/proxy';
import { listResources, registerResource, resolveOwner } from '../../services/resources';
import { ApiError, ProviderError } from '../../errors';
import { logger } from '../../logger';
import { forwardableQuery, listEnvelope, parsePagination, str } from '../../lib/http';
import type { ResourceKind } from '../../provider/resources';
import type { OrganizationRow } from '../../services/org';

/**
 * Most provider resources are plain CRUD over a single collection, differing only
 * in path and scope name. Generating those routers keeps the behaviour - * ownership checks, list envelopes, registry-backed reads - identical across
 * every resource, instead of fifteen near-copies that drift apart.
 *
 * Resources needing bespoke behaviour (agents, calls) get their own module.
 */

export interface ResourceRouteConfig {
  /** VoiceKernel path segment, e.g. "phone-numbers". */
  segment: string;
  /**
   * Field that identifies this resource the way a person does - the phone
   * number itself, not its uuid. Used to find what a duplicate collided with
   * when the provider declines to say.
   */
  identityField?: string;
  /** provider collection path, e.g. "/phone-number". */
  providerPath: string;
  /** Registry bucket used for ownership. */
  kind: ResourceKind;
  /** Scope prefix; defaults to `segment`. */
  scope?: string;
  /** Operations to expose. Defaults to full CRUD. */
  methods?: Array<'list' | 'create' | 'get' | 'update' | 'delete'>;
  /** Singular noun for messages. */
  label: string;
}

export function resourceRouter(cfg: ResourceRouteConfig): Router {
  const router = Router();
  const scope = cfg.scope ?? cfg.segment;
  const methods = new Set(cfg.methods ?? ['list', 'create', 'get', 'update', 'delete']);


  if (methods.has('list')) {
    router.get(
      '/',
      requireScope(`${scope}:read`),
      asyncHandler(async (req, res) => {
        const org = currentOrg(req);
        const { limit, offset } = parsePagination(req);

        // Registry-backed by default (org-scoped, paginated, no upstream cost);
        // ?refresh=true goes to the voice provider for authoritative state.
        if (str(req.query.refresh) === 'true') {
          const upstream = await proxyToProvider({
            org,
            method: 'GET',
            path: cfg.providerPath,
            query: { ...forwardableQuery(req), limit: Math.min(limit, 100) },
          });
          res.json(upstream.data);
          return;
        }

        const { items, total } = await listResources({
          orgId: org.id,
          kind: cfg.kind,
          limit,
          offset,
          search: str(req.query.search),
        });

        res.json(
          listEnvelope(
            items.map((row) => ({ id: row.provider_id, ...row.snapshot })),
            { total, limit, offset },
          ),
        );
      }),
    );
  }

  if (methods.has('create')) {
    router.post(
      '/',
      requireScope(`${scope}:write`),
      asyncHandler(async (req, res) => {
        const org = currentOrg(req);
        try {
          const result = await proxyToProvider({
            org,
            method: 'POST',
            path: cfg.providerPath,
            body: req.body,
            idempotencyKey: req.header('idempotency-key'),
          });
          res.status(result.status === 200 ? 201 : result.status).json(result.data);
        } catch (err) {
          const adopted = await adoptExistingResource(org, cfg, err, req.body);
          if (!adopted) throw err;
          res.status(200).json(adopted);
        }
      }),
    );
  }

  if (methods.has('get')) {
    router.get(
      '/:id',
      requireScope(`${scope}:read`),
      asyncHandler(async (req, res) => {
        const org = currentOrg(req);
        const result = await proxyToProvider({
          org,
          method: 'GET',
          path: `${cfg.providerPath}/${encodeURIComponent(req.params.id)}`,
        });
        res.status(result.status).json(result.data);
      }),
    );
  }

  if (methods.has('update')) {
    router.patch(
      '/:id',
      requireScope(`${scope}:write`),
      asyncHandler(async (req, res) => {
        const org = currentOrg(req);
        const result = await proxyToProvider({
          org,
          method: 'PATCH',
          path: `${cfg.providerPath}/${encodeURIComponent(req.params.id)}`,
          body: req.body,
        });
        res.status(result.status).json(result.data);
      }),
    );
  }

  if (methods.has('delete')) {
    router.delete(
      '/:id',
      requireScope(`${scope}:write`),
      asyncHandler(async (req, res) => {
        const org = currentOrg(req);
        const result = await proxyToProvider({
          org,
          method: 'DELETE',
          path: `${cfg.providerPath}/${encodeURIComponent(req.params.id)}`,
        });
        res.status(200).json(
          result.data && typeof result.data === 'object'
            ? result.data
            : { id: req.params.id, deleted: true },
        );
      }),
    );
  }

  return router;
}

/**
 * Every straightforward provider collection, exposed under a VoiceKernel-idiomatic
 * plural path. Anything not listed here is still reachable through
 * /v1/provider/* - see routes/v1/passthrough.ts.
 */
export const RESOURCE_ROUTES: ResourceRouteConfig[] = [
  {
    segment: 'phone-numbers',
    providerPath: '/phone-number',
    kind: 'phoneNumber',
    label: 'phone number',
    identityField: 'number',
  },
  { segment: 'squads', providerPath: '/squad', kind: 'squad', label: 'squad' },
  { segment: 'tools', providerPath: '/tool', kind: 'tool', label: 'tool' },
  { segment: 'files', providerPath: '/file', kind: 'file', label: 'file' },
  { segment: 'campaigns', providerPath: '/campaign', kind: 'campaign', label: 'campaign' },
  { segment: 'chats', providerPath: '/chat', kind: 'chat', label: 'chat', methods: ['list', 'create', 'get', 'delete'] },
  { segment: 'sessions', providerPath: '/session', kind: 'session', label: 'session' },
  { segment: 'evals', providerPath: '/eval', kind: 'eval', label: 'eval' },
  {
    segment: 'structured-outputs',
    providerPath: '/structured-output',
    kind: 'structuredOutput',
    scope: 'evals',
    label: 'structured output',
  },
  {
    segment: 'scorecards',
    providerPath: '/observability/scorecard',
    kind: 'scorecard',
    scope: 'analytics',
    label: 'scorecard',
    methods: ['list', 'create', 'get', 'update', 'delete'],
  },
  {
    segment: 'boards',
    providerPath: '/reporting/board',
    kind: 'board',
    scope: 'analytics',
    label: 'board',
  },
  {
    segment: 'insights',
    providerPath: '/reporting/insight',
    kind: 'insight',
    scope: 'analytics',
    label: 'insight',
  },
];

/**
 * Claims a resource that already exists upstream but is unknown to us.
 *
 * A phone number imported before this deployment existed - or through the
 * provider's own dashboard - is real, but has no row in the ownership registry,
 * so VoiceKernel cannot see it. Creating it again is the natural thing for an
 * operator to try, and the provider refuses:
 *
 *   Existing Phone Number <id> Has Identical `twilioAccountSid` ... and `number` ...
 *
 * That leaves the operator stuck with a number they own, cannot see, and
 * cannot re-add. So a duplicate is treated as a request to adopt it.
 *
 * The registry is still the trust boundary. Adoption happens only when nobody
 * owns the resource; one already owned by another tenant is refused, and
 * deliberately without confirming that it exists, which would let a tenant
 * probe for other tenants' ids.
 *
 * Returns the adopted resource, or null if this error was not an adoptable
 * duplicate - in which case the caller rethrows the original error.
 */
async function adoptExistingResource(
  org: OrganizationRow,
  cfg: ResourceRouteConfig,
  err: unknown,
  body: unknown,
): Promise<unknown | null> {
  if (!(err instanceof ProviderError) || err.status !== 400) return null;

  const message = typeof err.message === 'string' ? err.message : '';
  // The id is only available in prose; the provider returns no structured
  // field for it. Anchored on "Existing" so an unrelated 400 that happens to
  // contain a uuid is not mistaken for a duplicate.
  const match = /existing\b[^.]*?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(message);
  if (!match) {
    // Only prose that clearly reports a collision; an unrelated 400 must keep
    // its own error rather than being retried as an adoption.
    if (!/already in use|already exists|identical/i.test(message)) return null;
    return adoptByIdentity(org, cfg, body);
  }

  const providerId = match[1];
  return adoptById(org, cfg, providerId);
}

/**
 * Second route to the same outcome, for when the provider names no id.
 *
 * Re-importing an already-imported number is answered with "Phone number X
 * already in use by another org", which carries no uuid and - despite the
 * wording - is also what you get when the number is sitting in your own
 * account. Since the collection is readable, the object it collided with can
 * simply be looked up by the identifying field the operator typed.
 */
async function adoptByIdentity(
  org: OrganizationRow,
  cfg: ResourceRouteConfig,
  body: unknown,
): Promise<unknown | null> {
  if (!cfg.identityField) return null;
  const record = (body ?? {}) as Record<string, unknown>;
  const wanted = record[cfg.identityField];
  if (typeof wanted !== 'string' || !wanted) return null;

  const listed = await proxyToProvider({
    org,
    method: 'GET',
    path: cfg.providerPath,
    adoptUnowned: true,
  });

  const items = Array.isArray(listed.data) ? listed.data : [];
  const hit = items.find(
    (item) =>
      item && typeof item === 'object' &&
      (item as Record<string, unknown>)[cfg.identityField as string] === wanted,
  ) as Record<string, unknown> | undefined;

  if (!hit || typeof hit.id !== 'string') return null;
  return adoptById(org, cfg, hit.id);
}

async function adoptById(
  org: OrganizationRow,
  cfg: ResourceRouteConfig,
  providerId: string,
): Promise<unknown | null> {
  const owner = await resolveOwner(providerId);

  if (owner && owner.orgId !== org.id) {
    throw new ApiError(
      409,
      'resource_conflict',
      `A ${cfg.label} with these details already exists and is not available to this organization.`,
    );
  }

  // Read it back through the proxy so the response is the same shape a create
  // would have produced, rather than something assembled from the error text.
  const existing = await proxyToProvider({
    org,
    method: 'GET',
    path: `${cfg.providerPath}/${providerId}`,
    // The ownership pre-flight would otherwise reject this read precisely
    // because the resource is not registered - which is what is being fixed.
    // The proxy re-verifies that nobody owns it.
    adoptUnowned: true,
  });

  await registerResource({
    orgId: org.id,
    kind: cfg.kind,
    providerId,
    name: extractName(existing.data),
    snapshot: existing.data,
  });

  logger.info(
    { orgId: org.id, kind: cfg.kind, providerId },
    'adopted an existing provider resource that no organization owned',
  );

  return existing.data;
}

function extractName(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  for (const key of ['name', 'number', 'label']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return null;
}
