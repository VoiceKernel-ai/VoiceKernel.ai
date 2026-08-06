import { ApiError } from '../errors';
import { logger } from '../logger';
import { config } from '../config';
import type { ProviderOperation } from '../provider/operations.generated';
import { matchProviderOperation } from '../provider/operations.generated';
import { toPublicPayload, toWirePayload } from '../provider/aliases';
import {
  POLICY_BY_OPERATION,
  extractResourceId,
  extractResourceName,
  kindForPath,
  type OperationPolicy,
} from '../provider/resources';
import { resolveProviderClient, type OrganizationRow } from './org';
import {
  isOwned,
  resolveOwner,
  markResourceDeleted,
  ownedIds,
  registerResource,
  updateSnapshot,
} from './resources';
import { recordCallFromProvider } from './calls';

export interface ProxyRequest {
  org: OrganizationRow;
  method: string;
  /** Provider-relative path, e.g. "/assistant/abc". */
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
  /** Which provider credential this operation authenticates with. */
  credential?: 'private' | 'public';
  /**
   * Permits reading a resource this org does not own *yet*, so it can be
   * adopted. The ownership rule is not waived: the proxy re-checks that the
   * resource is genuinely unowned, so a caller passing this can still never
   * reach another tenant's data.
   */
  adoptUnowned?: boolean;
}

export interface ProxyResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
  endpoint: ProviderOperation;
}

/**
 * The single choke point for every provider call VoiceKernel makes on behalf of a
 * tenant. Nothing reaches the voice provider without passing through here.
 *
 * Order of operations matters:
 *   1. Resolve the request to a known provider operation. Unknown paths are
 *      rejected outright rather than forwarded.
 *   2. Enforce the operation's policy BEFORE the upstream call, so an
 *      unauthorised read never actually happens.
 *   3. Forward with the org's credential.
 *   4. Reconcile our registry with the result (register creates, filter lists,
 *      soft-delete removals).
 */
export async function proxyToProvider(req: ProxyRequest): Promise<ProxyResult> {
  const pathname = normalisePath(req.path);
  const match = matchProviderOperation(req.method, pathname);

  if (!match) {
    throw ApiError.notFound(
      `No provider operation matches ${req.method.toUpperCase()} ${pathname}. See GET /v1/provider/_operations for the supported surface.`,
    );
  }

  const { endpoint, params } = match;
  const policy = POLICY_BY_OPERATION.get(endpoint.operationId) ?? {
    kind: kindForPath(endpoint.path),
    scope: 'tenant' as const,
  };
  // Authorisation runs before credential resolution. If it ran after, a
  // deployment with no provider key would answer 503 for a request that should have
  // been 404 - leaking that the failure was configuration rather than
  // permission, and making the isolation behaviour depend on unrelated config.
  await enforcePreflight(req.org, req.org.provider_mode, endpoint, policy, params, req.adoptUnowned === true);

  const { client, mode } = resolveProviderClient(req.org, req.credential ?? 'private');

  // Artifact downloads answer 302 with a presigned URL rather than JSON.
  if (endpoint.isRedirect) {
    return fetchArtifact(req, endpoint, client);
  }

  const response = await client.request({
    method: endpoint.method,
    path: pathname,
    query: req.query,
    // The upstream's in-house provider is exposed to customers under our own
    // name; translate it back to the id the upstream actually accepts.
    body: toWirePayload(req.body),
    formData: req.formData,
    idempotencyKey: req.idempotencyKey,
  });

  const reconciled = await reconcile(req.org, mode, endpoint, policy, params, response.data);

  // Translated on the way out too, so the vendor id never reaches a customer -
  // including through the raw passthrough object, which is otherwise verbatim.
  const data = toPublicPayload(reconciled);

  return { status: response.status, data, headers: response.headers, endpoint };
}

// ---------------------------------------------------------------------------
// Step 2 - pre-flight authorisation
// ---------------------------------------------------------------------------

async function enforcePreflight(
  org: OrganizationRow,
  mode: 'platform' | 'byo',
  endpoint: ProviderOperation,
  policy: OperationPolicy,
  params: Record<string, string>,
  adoptUnowned = false,
): Promise<void> {
  // BYO tenants talk to their own provider account. Every object in it is theirs,
  // so there is nothing for us to gate - the voice provider's own auth is the boundary.
  if (mode === 'byo') return;

  if (policy.scope === 'tenant') {
    throw new ApiError(
      409,
      'unsupported_in_platform_mode',
      `${endpoint.method} ${endpoint.path} returns data for the entire provider account, which VoiceKernel cannot safely scope to one organization on the shared platform key. ` +
        `Use the VoiceKernel-native equivalent (for analytics: POST /v1/analytics), or add your own provider key under Settings → Provider to enable direct passthrough.`,
    );
  }

  if (policy.scope === 'owned' && policy.idParam) {
    const id = params[policy.idParam];
    const kind = policy.kind;
    if (!kind) {
      throw ApiError.forbidden(
        `VoiceKernel cannot determine ownership for ${endpoint.path}; refusing on the shared platform key.`,
      );
    }
    if (!id || !(await isOwned(org.id, kind, id))) {
      // Adoption reads a resource that is deliberately not yet owned. The rule
      // still holds - it is re-checked here rather than trusted from the
      // caller - so this can only ever reach a resource nobody owns.
      if (adoptUnowned && id) {
        const owner = await resolveOwner(id);
        if (!owner || owner.orgId === org.id) return;
      }
      // Deliberately 404, not 403: confirming existence would leak that the ID
      // is real and belongs to some other tenant.
      throw ApiError.notFound(`No ${kind} with id '${id}' exists in this organization.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4 - reconcile our registry with what the voice provider returned
// ---------------------------------------------------------------------------

async function reconcile(
  org: OrganizationRow,
  mode: 'platform' | 'byo',
  endpoint: ProviderOperation,
  policy: OperationPolicy,
  params: Record<string, string>,
  data: unknown,
): Promise<unknown> {
  const kind = policy.kind;
  if (!kind) return data;

  try {
    switch (policy.scope) {
      case 'create': {
        const id = extractResourceId(data);
        if (id) {
          await registerResource({
            orgId: org.id,
            kind,
            providerId: id,
            name: extractResourceName(data),
            snapshot: data,
          });
          if (kind === 'call') await recordCallFromProvider(org.id, data);
        }
        return data;
      }

      case 'list': {
        // Keep our snapshots warm, then hide anything this org does not own.
        const items = extractList(data);
        if (!items) return data;

        if (mode === 'byo') {
          await Promise.all(
            items.map(async (item) => {
              const id = extractResourceId(item);
              if (id) {
                await registerResource({
                  orgId: org.id,
                  kind,
                  providerId: id,
                  name: extractResourceName(item),
                  snapshot: item,
                });
              }
            }),
          );
          return data;
        }

        const owned = await ownedIds(org.id, kind);
        const filtered = items.filter((item) => {
          const id = extractResourceId(item);
          return id !== null && owned.has(id);
        });
        return replaceList(data, filtered);
      }

      case 'owned': {
        const id = params[policy.idParam ?? 'id'];
        if (!id) return data;

        if (endpoint.method === 'DELETE') {
          await markResourceDeleted(org.id, kind, id);
        } else if (data && typeof data === 'object') {
          await updateSnapshot(org.id, kind, id, data);
          if (kind === 'call') await recordCallFromProvider(org.id, data);
        }
        return data;
      }

      default:
        return data;
    }
  } catch (err) {
    // Bookkeeping must never fail a request that the voice provider already accepted - // otherwise the caller retries and we place a second call.
    logger.error(
      { err, operationId: endpoint.operationId, orgId: org.id },
      'resource reconciliation failed after successful upstream call',
    );
    return data;
  }
}

// ---------------------------------------------------------------------------
// Artifact downloads (recordings, pcap, call logs)
// ---------------------------------------------------------------------------

/**
 * The provider answers artifact requests with a 302 to a short-lived presigned URL.
 * We resolve it without following, and hand the caller the URL plus its
 * expiry - streaming multi-megabyte audio through the control plane would
 * add latency and cost for no benefit.
 */
async function fetchArtifact(
  req: ProxyRequest,
  endpoint: ProviderOperation,
  client: ReturnType<typeof resolveProviderClient>['client'],
): Promise<ProxyResult> {
  const response = await client.request({
    method: 'GET',
    path: normalisePath(req.path),
    query: req.query,
    headers: { Accept: '*/*' },
  });

  const location = response.headers.location ?? response.headers.Location;
  if (location) {
    return {
      status: 200,
      data: { url: location, expiresIn: 3600, artifact: artifactName(endpoint.path) },
      headers: response.headers,
      endpoint,
    };
  }
  return { status: response.status, data: response.data, headers: response.headers, endpoint };
}

function artifactName(path: string): string {
  const last = path.split('/').pop() ?? 'artifact';
  return last.replace(/[{}]/g, '');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalisePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  // Strip a query string if the caller embedded one in the path.
  return withSlash.split('?')[0].replace(/\/+$/, '') || '/';
}

/**
 * provider list endpoints return either a bare array or `{ results: [...] }`
 * depending on the resource and API version. Both shapes are handled so the
 * filter works uniformly.
 */
function extractList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['results', 'data', 'items']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return null;
}

function replaceList(data: unknown, items: unknown[]): unknown {
  if (Array.isArray(data)) return items;
  if (data && typeof data === 'object') {
    const record = { ...(data as Record<string, unknown>) };
    for (const key of ['results', 'data', 'items']) {
      if (Array.isArray(record[key])) {
        record[key] = items;
        // The upstream total counts the whole account; ours must not.
        if (record.metadata && typeof record.metadata === 'object') {
          record.metadata = { ...(record.metadata as object), itemsReturned: items.length };
        }
        return record;
      }
    }
  }
  return items;
}

/** Exposed for the docs/introspection endpoint. */
export function describeSurface() {
  return {
    baseUrl: `${config.publicBaseUrl}/v1/provider`,
    upstream: config.provider.baseUrl,
    operations: [...POLICY_BY_OPERATION.entries()].length,
  };
}
