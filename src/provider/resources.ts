import { PROVIDER_OPERATIONS, type ProviderOperation } from './operations.generated';

/**
 * Ownership model
 * ===============
 * VoiceKernel proxies to the voice provider. In `platform` mode many tenants share a single
 * provider account, so a provider object ID proves nothing about who may touch it.
 * The `resources` table is the trust boundary: every object we create is
 * registered against an org, and every id-scoped request re-checks it.
 *
 * This file classifies each provider operation so the proxy knows what to enforce:
 *
 *   kind            which registry bucket the object belongs to
 *   scope           'owned' - id-scoped; must resolve to the caller's org
 *                   'list' - collection; results filtered to the caller
 *                   'create' - registers a new object on success
 *                   'tenant' - account-wide data; unsafe to share (see below)
 *                   'stateless'- no tenant-identifying data (previews, runs)
 *
 * Operations marked 'tenant' return data aggregated across the whole the provider
 * account. In platform mode that is every tenant's data at once, so the proxy
 * refuses them and VoiceKernel answers from its own per-org tables instead.
 * In BYO mode the account belongs solely to the tenant, so they pass through.
 */

export type ResourceKind =
  | 'assistant'
  | 'call'
  | 'phoneNumber'
  | 'squad'
  | 'tool'
  | 'file'
  | 'campaign'
  | 'chat'
  | 'session'
  | 'eval'
  | 'evalRun'
  | 'structuredOutput'
  | 'scorecard'
  | 'board'
  | 'insight'
  | 'providerResource';

export type OperationScope = 'owned' | 'list' | 'create' | 'tenant' | 'stateless';

export interface OperationPolicy {
  kind: ResourceKind | null;
  scope: OperationScope;
  /** Path parameter naming the object whose ownership must be checked. */
  idParam?: string;
}

/** Root path segment -> resource kind. */
const KIND_BY_PATH_ROOT: Array<[RegExp, ResourceKind]> = [
  [/^\/assistant(\/|$)/, 'assistant'],
  [/^\/call(\/|$)/, 'call'],
  [/^\/(v2\/)?phone-number(\/|$)/, 'phoneNumber'],
  [/^\/squad(\/|$)/, 'squad'],
  [/^\/tool(\/|$)/, 'tool'],
  [/^\/file(\/|$)/, 'file'],
  [/^\/(v2\/)?campaign(\/|$)/, 'campaign'],
  [/^\/chat(\/|$)/, 'chat'],
  [/^\/session(\/|$)/, 'session'],
  [/^\/eval\/run(\/|$)/, 'evalRun'],
  [/^\/eval(\/|$)/, 'eval'],
  [/^\/structured-output(\/|$)/, 'structuredOutput'],
  [/^\/observability\/scorecard(\/|$)/, 'scorecard'],
  [/^\/reporting\/board(\/|$)/, 'board'],
  [/^\/reporting\/insight(\/|$)/, 'insight'],
  [/^\/provider\//, 'providerResource'],
];

export function kindForPath(path: string): ResourceKind | null {
  for (const [regex, kind] of KIND_BY_PATH_ROOT) {
    if (regex.test(path)) return kind;
  }
  return null;
}

/**
 * Operations whose results span the entire provider account. Blocked in platform
 * mode; VoiceKernel serves the org-scoped equivalent from its own tables.
 */
const ACCOUNT_WIDE_OPERATIONS = new Set<string>([
  'AnalyticsController_query',
  'BoardController_metricsOverviewEnsure',
]);

/** Operations that neither read nor create tenant-identifiable state. */
const STATELESS_OPERATIONS = new Set<string>([
  'InsightController_preview',
  'StructuredOutputController_run',
  'ChatController_createOpenAIChat',
]);

export function policyFor(endpoint: ProviderOperation): OperationPolicy {
  const kind = kindForPath(endpoint.path);

  if (ACCOUNT_WIDE_OPERATIONS.has(endpoint.operationId)) {
    return { kind, scope: 'tenant' };
  }
  if (STATELESS_OPERATIONS.has(endpoint.operationId)) {
    return { kind, scope: 'stateless' };
  }

  // Provider resources are keyed by {provider, resourceName, id}; the id is the
  // only tenant-specific part and still resolves through the registry.
  const idParam = endpoint.pathParams.includes('id') ? 'id' : undefined;

  if (idParam) return { kind, scope: 'owned', idParam };
  if (endpoint.method === 'POST') return { kind, scope: 'create' };
  if (endpoint.method === 'GET') return { kind, scope: 'list' };

  return { kind, scope: 'tenant' };
}

/** Precomputed policy per operationId, so the proxy does no work per request. */
export const POLICY_BY_OPERATION: ReadonlyMap<string, OperationPolicy> = new Map(
  PROVIDER_OPERATIONS.map((e) => [e.operationId, policyFor(e)]),
);

/**
 * Where a created object's ID lives in a provider response. Almost everything uses
 * `id`; this indirection exists so an exception does not require a new branch
 * in the proxy.
 */
export function extractResourceId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const id = record.id ?? record.callId ?? record.chatId;
  return typeof id === 'string' ? id : null;
}

export function extractResourceName(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  for (const key of ['name', 'title', 'label']) {
    const v = record[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Human-facing plural labels, used by the docs page and the dashboard. */
export const KIND_LABELS: Record<ResourceKind, string> = {
  assistant: 'Agents',
  call: 'Calls',
  phoneNumber: 'Phone numbers',
  squad: 'Squads',
  tool: 'Tools',
  file: 'Files',
  campaign: 'Campaigns',
  chat: 'Chats',
  session: 'Sessions',
  eval: 'Evals',
  evalRun: 'Eval runs',
  structuredOutput: 'Structured outputs',
  scorecard: 'Scorecards',
  board: 'Boards',
  insight: 'Insights',
  providerResource: 'Provider resources',
};
