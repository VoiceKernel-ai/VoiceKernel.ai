import crypto from 'node:crypto';
import { VoiceKernelConnectionError, VoiceKernelError, type ApiErrorBody } from './errors';
import type {
  Agent,
  AgentInput,
  AnalyticsOverview,
  ArtifactUrl,
  BudgetStatus,
  Call,
  CallArtifact,
  CallTranscript,
  Catalog,
  CreateCallInput,
  ErasureReceipt,
  LatencyBudget,
  ListParams,
  ListResponse,
  ModelSelection,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from './types';

export interface VoiceKernelOptions {
  /** Your API key, `vk_live_…` or `vk_test_…`. */
  apiKey: string;
  /** Defaults to https://api.voicekernel.ai */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30000. */
  timeout?: number;
  /** Retries for transient failures. Default 2. */
  maxRetries?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Makes a retry safe on a non-idempotent method. */
  idempotencyKey?: string;
  timeout?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * VoiceKernel API client.
 *
 *   const vk = new VoiceKernel({ apiKey: process.env.VK_API_KEY! });
 *
 *   const agent = await vk.agents.create({
 *     name: 'Card disputes',
 *     systemPrompt: 'You are a card disputes specialist…',
 *     model: { provider: 'anthropic', model: 'claude-sonnet-5' },
 *   });
 *
 *   await vk.calls.create({ to: '+61400000000', agentId: agent.id });
 */
export class VoiceKernel {
  readonly agents: AgentsResource;
  readonly calls: CallsResource;
  readonly phoneNumbers: CrudResource<Record<string, unknown>>;
  readonly tools: CrudResource<Record<string, unknown>>;
  readonly files: FilesResource;
  readonly squads: CrudResource<Record<string, unknown>>;
  readonly campaigns: CampaignsResource;
  readonly chats: CrudResource<Record<string, unknown>>;
  readonly evals: CrudResource<Record<string, unknown>>;
  readonly structuredOutputs: CrudResource<Record<string, unknown>>;
  readonly webhookEndpoints: WebhookEndpointsResource;
  readonly analytics: AnalyticsResource;
  readonly catalog: CatalogResource;
  readonly billing: BillingResource;
  readonly subjects: SubjectsResource;
  readonly apiKeys: CrudResource<Record<string, unknown>>;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: VoiceKernelOptions) {
    if (!options?.apiKey) {
      throw new Error('VoiceKernel requires an apiKey. Create one under Settings → API keys.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.voicekernel.ai').replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.extraHeaders = options.headers ?? {};

    const impl = options.fetch ?? globalThis.fetch;
    if (!impl) {
      throw new Error('No fetch implementation available. Use Node 18+ or pass one via options.fetch.');
    }
    this.fetchImpl = impl;

    this.agents = new AgentsResource(this);
    this.calls = new CallsResource(this);
    this.phoneNumbers = new CrudResource(this, '/v1/phone-numbers');
    this.tools = new CrudResource(this, '/v1/tools');
    this.files = new FilesResource(this);
    this.squads = new CrudResource(this, '/v1/squads');
    this.campaigns = new CampaignsResource(this);
    this.chats = new CrudResource(this, '/v1/chats');
    this.evals = new CrudResource(this, '/v1/evals');
    this.structuredOutputs = new CrudResource(this, '/v1/structured-outputs');
    this.webhookEndpoints = new WebhookEndpointsResource(this);
    this.analytics = new AnalyticsResource(this);
    this.catalog = new CatalogResource(this);
    this.billing = new BillingResource(this);
    this.subjects = new SubjectsResource(this);
    this.apiKeys = new CrudResource(this, '/v1/api-keys');
  }

  /**
   * Escape hatch to any upstream provider operation not wrapped above.
   *
   * Same auth, tenant isolation, rate limiting and audit as the typed methods.
   * `GET /v1/provider/_operations` enumerates what is reachable.
   */
  async provider<T = unknown>(
    method: RequestOptions['method'],
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const clean = path.startsWith('/') ? path : `/${path}`;
    return this.request<T>({ method, path: `/v1/provider${clean}`, ...options });
  }

  /** @internal */
  async request<T>(options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(options.path, options.query);

    // POST/PATCH are only replayed when the caller supplied an idempotency key.
    // Without one, a retry could place a second call.
    const replayable = method === 'GET' || method === 'DELETE' || Boolean(options.idempotencyKey);
    const attempts = replayable ? this.maxRetries : 0;

    let lastConnectionError: unknown;

    for (let attempt = 0; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout ?? this.timeout);

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'voicekernel-node/1.0',
          ...this.extraHeaders,
        };
        if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

        let payload: string | FormData | undefined;
        if (options.body instanceof FormData) {
          payload = options.body;
        } else if (options.body !== undefined && method !== 'GET') {
          headers['Content-Type'] = 'application/json';
          payload = JSON.stringify(options.body);
        }

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        });

        const text = await response.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }

        if (response.ok) return parsed as T;

        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
          await sleep(this.backoff(attempt, response.headers.get('retry-after')));
          continue;
        }

        const body = (parsed as { error?: ApiErrorBody } | null)?.error ?? {};
        throw new VoiceKernelError(response.status, body, `Request failed with status ${response.status}`);
      } catch (err) {
        if (err instanceof VoiceKernelError) throw err;
        lastConnectionError = err;
        if (attempt < attempts) {
          await sleep(this.backoff(attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    const reason =
      lastConnectionError instanceof Error && lastConnectionError.name === 'AbortError'
        ? `timed out after ${options.timeout ?? this.timeout}ms`
        : lastConnectionError instanceof Error
          ? lastConnectionError.message
          : 'unknown transport error';

    throw new VoiceKernelConnectionError(`Could not reach VoiceKernel: ${reason}`, lastConnectionError);
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
        else url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Exponential backoff with full jitter, honouring Retry-After. */
  private backoff(attempt: number, retryAfter?: string | null): number {
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 20_000);
    }
    return Math.floor(Math.random() * Math.min(500 * 2 ** attempt, 8_000)) + 100;
  }

  /** Generates an idempotency key. */
  static idempotencyKey(): string {
    return crypto.randomUUID();
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

class BaseResource {
  constructor(protected readonly client: VoiceKernel) {}

  /**
   * Walks every page of a collection.
   *
   *   for await (const call of vk.calls.iterate()) { … }
   *
   * Offset pagination is used because that is what the API exposes; the loop
   * stops when a page comes back short rather than trusting a total that could
   * shift underneath a long walk.
   */
  protected async *paginate<T>(path: string, params: ListParams = {}): AsyncGenerator<T> {
    const limit = Math.min(Number(params.limit ?? 100), 200);
    let offset = Number(params.offset ?? 0);

    for (;;) {
      const page = await this.client.request<ListResponse<T>>({
        path,
        query: { ...params, limit, offset },
      });
      const items = page.data ?? [];
      for (const item of items) yield item;

      if (items.length < limit) return;
      if (page.pagination?.hasMore === false) return;
      offset += items.length;
    }
  }
}

/** Standard CRUD, shared by the resources that need nothing bespoke. */
class CrudResource<T> extends BaseResource {
  constructor(client: VoiceKernel, protected readonly path: string) {
    super(client);
  }

  list(params: ListParams = {}): Promise<ListResponse<T>> {
    return this.client.request({ path: this.path, query: params });
  }

  iterate(params: ListParams = {}): AsyncGenerator<T> {
    return this.paginate<T>(this.path, params);
  }

  create(body: Record<string, unknown>, options: { idempotencyKey?: string } = {}): Promise<T> {
    return this.client.request({ method: 'POST', path: this.path, body, ...options });
  }

  retrieve(id: string): Promise<T> {
    return this.client.request({ path: `${this.path}/${encodeURIComponent(id)}` });
  }

  update(id: string, body: Record<string, unknown>): Promise<T> {
    return this.client.request({ method: 'PATCH', path: `${this.path}/${encodeURIComponent(id)}`, body });
  }

  delete(id: string): Promise<{ id: string; deleted?: boolean }> {
    return this.client.request({ method: 'DELETE', path: `${this.path}/${encodeURIComponent(id)}` });
  }
}

class AgentsResource extends CrudResource<Agent> {
  constructor(client: VoiceKernel) {
    super(client, '/v1/agents');
  }

  override create(body: AgentInput, options: { idempotencyKey?: string } = {}): Promise<Agent> {
    return this.client.request({ method: 'POST', path: this.path, body, ...options });
  }

  override update(id: string, body: AgentInput): Promise<Agent> {
    return this.client.request({ method: 'PATCH', path: `${this.path}/${encodeURIComponent(id)}`, body });
  }

  /**
   * Swaps the model, preserving the prompt.
   *
   * The equivalent PATCH requires knowing the prompt lives inside
   * `model.messages`; this does not.
   */
  setModel(id: string, model: ModelSelection): Promise<Agent> {
    return this.client.request({
      method: 'PUT',
      path: `${this.path}/${encodeURIComponent(id)}/model`,
      body: model,
    });
  }

  /** Updates instructions only, leaving model, voice and plans untouched. */
  setPrompt(id: string, systemPrompt: string, firstMessage?: string | null): Promise<Agent> {
    return this.client.request({
      method: 'PUT',
      path: `${this.path}/${encodeURIComponent(id)}/prompt`,
      body: { systemPrompt, ...(firstMessage !== undefined ? { firstMessage } : {}) },
    });
  }
}

class CallsResource extends CrudResource<Call> {
  constructor(client: VoiceKernel) {
    super(client, '/v1/calls');
  }

  /**
   * Places a call. An idempotency key is generated by default - retrying a
   * timed-out request must never place a second call.
   */
  override create(body: CreateCallInput, options: { idempotencyKey?: string } = {}): Promise<Call> {
    return this.client.request({
      method: 'POST',
      path: this.path,
      body,
      idempotencyKey: options.idempotencyKey ?? VoiceKernel.idempotencyKey(),
    });
  }

  transcript(id: string): Promise<CallTranscript> {
    return this.client.request({ path: `${this.path}/${encodeURIComponent(id)}/transcript` });
  }

  /** Short-lived presigned URL for a recording, pcap or call log. */
  artifact(id: string, artifact: CallArtifact = 'recording'): Promise<ArtifactUrl> {
    return this.client.request({ path: `${this.path}/${encodeURIComponent(id)}/artifacts/${artifact}` });
  }

  /** Ends a live call, or deletes its stored data once finished. */
  end(id: string): Promise<{ id: string; deleted?: boolean }> {
    return this.delete(id);
  }
}

class FilesResource extends CrudResource<Record<string, unknown>> {
  constructor(client: VoiceKernel) {
    super(client, '/v1/files');
  }

  /** Uploads a knowledge document. */
  upload(file: Blob | Buffer, filename: string, name?: string): Promise<Record<string, unknown>> {
    const form = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file as unknown as BlobPart]);
    form.append('file', blob, filename);
    if (name) form.append('name', name);
    return this.client.request({ method: 'POST', path: this.path, body: form });
  }
}

class CampaignsResource extends CrudResource<Record<string, unknown>> {
  constructor(client: VoiceKernel) {
    super(client, '/v1/campaigns');
  }

  /**
   * Validates a campaign before it dials anyone: E.164 validity, duplicates,
   * calling window, AI disclosure and budget headroom.
   *
   * Checks needing an integration the deployment lacks report `not_available`
   * rather than passing - treat those as unverified, not as satisfied.
   */
  preflight(input: {
    numbers: string[];
    window?: { start?: string; end?: string };
    firstMessage?: string;
    agentId?: string;
    maxAttempts?: number;
    concurrency?: number;
    suppressionList?: string[];
  }): Promise<{
    audience: { uploaded: number; invalid: number; duplicates: number; suppressed: number; callable: number };
    checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'not_available'; detail: string }>;
    canLaunch: boolean;
    projection: Record<string, unknown>;
  }> {
    return this.client.request({ method: 'POST', path: `${this.path}/preflight`, body: input });
  }
}

class WebhookEndpointsResource extends BaseResource {
  list(): Promise<ListResponse<WebhookEndpoint> & { availableEvents: string[] }> {
    return this.client.request({ path: '/v1/webhook-endpoints' });
  }

  create(input: { url: string; description?: string; events?: string[] }): Promise<WebhookEndpointCreated> {
    return this.client.request({ method: 'POST', path: '/v1/webhook-endpoints', body: input });
  }

  update(
    id: string,
    patch: { url?: string; description?: string; events?: string[]; enabled?: boolean },
  ): Promise<WebhookEndpoint> {
    return this.client.request({ method: 'PATCH', path: `/v1/webhook-endpoints/${id}`, body: patch });
  }

  delete(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.client.request({ method: 'DELETE', path: `/v1/webhook-endpoints/${id}` });
  }

  /** Retrieves the signing secret. Audited. */
  secret(id: string): Promise<{ id: string; secret: string }> {
    return this.client.request({ path: `/v1/webhook-endpoints/${id}/secret` });
  }

  /** Sends a synthetic event so you can verify signature checking. */
  test(id: string): Promise<{ delivered: boolean; responseStatus?: number; error?: string }> {
    return this.client.request({ method: 'POST', path: `/v1/webhook-endpoints/${id}/test` });
  }

  deliveries(id: string, params: ListParams = {}): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request({ path: `/v1/webhook-endpoints/${id}/deliveries`, query: params });
  }

  replay(deliveryId: string): Promise<{ id: string; replayed: boolean }> {
    return this.client.request({
      method: 'POST',
      path: `/v1/webhook-endpoints/deliveries/${deliveryId}/replay`,
    });
  }
}

class AnalyticsResource extends BaseResource {
  overview(params: { since?: string; until?: string } = {}): Promise<AnalyticsOverview> {
    return this.client.request({ path: '/v1/analytics/overview', query: params });
  }

  timeseries(params: { since?: string; until?: string; granularity?: 'hour' | 'day' | 'week' } = {}) {
    return this.client.request<{ data: Array<{ bucket: string; calls: number; minutes: number; cost: number }> }>({
      path: '/v1/analytics/timeseries',
      query: params,
    });
  }

  byAgent(params: { since?: string; until?: string } = {}) {
    return this.client.request<{ data: Array<Record<string, unknown>> }>({
      path: '/v1/analytics/agents',
      query: params,
    });
  }

  /** Where the voice-to-voice round trip is spent, against your SLA. */
  latency(params: { since?: string; until?: string; slaMs?: number } = {}): Promise<LatencyBudget> {
    return this.client.request({ path: '/v1/analytics/latency', query: params });
  }

  monitors() {
    return this.client.request<{ monitors: Array<Record<string, unknown>>; issues: Array<Record<string, unknown>> }>({
      path: '/v1/observe/monitors',
    });
  }
}

class CatalogResource extends BaseResource {
  /** Every provider and model the API will accept today. */
  list(): Promise<Catalog> {
    return this.client.request({ path: '/v1/catalog' });
  }

  models() {
    return this.client.request<ListResponse<Record<string, unknown>>>({ path: '/v1/catalog/models' });
  }

  voices() {
    return this.client.request<ListResponse<Record<string, unknown>>>({ path: '/v1/catalog/voices' });
  }

  transcribers() {
    return this.client.request<ListResponse<Record<string, unknown>>>({ path: '/v1/catalog/transcribers' });
  }

  actions() {
    return this.client.request<{ total: number; groups: Array<Record<string, unknown>> }>({
      path: '/v1/catalog/actions',
    });
  }
}

class BillingResource extends BaseResource {
  get(): Promise<{ settings: Record<string, unknown>; status: BudgetStatus; policy: Record<string, string> }> {
    return this.client.request({ path: '/v1/governance/billing' });
  }

  update(patch: {
    monthlyBudget?: number | null;
    alertThresholds?: number[];
    requireApprovalAtLimit?: boolean;
    billingEntity?: string | null;
    costAllocationTag?: string | null;
    paymentMethod?: 'card' | 'invoice' | 'direct_debit' | null;
  }) {
    return this.client.request<{ settings: Record<string, unknown>; status: BudgetStatus }>({
      method: 'PUT',
      path: '/v1/governance/billing',
      body: patch,
    });
  }

  /** Minutes a budget buys, from your measured rate where one exists. */
  estimate(budget: number) {
    return this.client.request<{ minutes: number; ratePerMinute: number; basis: string }>({
      path: '/v1/governance/billing/estimate',
      query: { budget },
    });
  }
}

class SubjectsResource extends BaseResource {
  /** What an erasure would touch, without touching it. */
  preview(subject: string) {
    return this.client.request<{ subject: string; calls: number; earliest: string | null; latest: string | null }>({
      path: `/v1/subjects/${encodeURIComponent(subject)}`,
    });
  }

  /**
   * Erases a caller across this organization.
   *
   * Destructive and not reversible. Check `receipt.complete` - a partial
   * provider failure returns 207 with the outstanding call IDs, and must not
   * be treated as a finished erasure.
   */
  erase(subject: string, options: { upstream?: boolean } = {}): Promise<ErasureReceipt> {
    return this.client.request({
      method: 'DELETE',
      path: `/v1/subjects/${encodeURIComponent(subject)}`,
      query: options.upstream === false ? { upstream: 'false' } : undefined,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
