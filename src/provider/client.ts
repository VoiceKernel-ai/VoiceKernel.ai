import { config } from '../config';
import { logger } from '../logger';
import { ProviderError, ApiError } from '../errors';

export interface ProviderRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  /** Pre-built multipart body; when set, `body` is ignored. */
  formData?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Overrides the default retry policy for this call. */
  maxRetries?: number;
  idempotencyKey?: string;
}

export interface ProviderResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/** Methods safe to replay when the upstream is unreachable or overloaded. */
const RETRYABLE_METHODS = new Set(['GET', 'DELETE']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ProviderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = config.provider.baseUrl) {
    if (!apiKey) {
      throw ApiError.notConfigured(
        'No provider API key is configured for this organization. Set one under Settings → Provider, or configure PROVIDER_API_KEY for platform mode.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request<T = unknown>(opts: ProviderRequestOptions): Promise<ProviderResponse<T>> {
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(opts.path, opts.query);

    // POST/PATCH are only replayed when the caller supplied an idempotency key,
    // otherwise a retry risks placing a second call or double-charging.
    const retryable = RETRYABLE_METHODS.has(method) || Boolean(opts.idempotencyKey);
    const maxRetries = opts.maxRetries ?? (retryable ? config.provider.maxRetries : 0);

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.send<T>(method, url, opts);
        if (res.status >= 400 && RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          const delay = this.backoff(attempt, res.headers['retry-after']);
          logger.warn(
            { status: res.status, path: opts.path, attempt, delay },
            'provider request retryable failure, backing off',
          );
          await sleep(delay);
          continue;
        }
        if (res.status >= 400) {
          throw new ProviderError(res.status, res.data);
        }
        return res;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        lastError = err;
        // Network-level failure (DNS, socket, timeout).
        if (attempt < maxRetries) {
          const delay = this.backoff(attempt);
          logger.warn({ err, path: opts.path, attempt, delay }, 'provider request transport error, retrying');
          await sleep(delay);
          continue;
        }
      }
    }

    const message =
      lastError instanceof Error && lastError.name === 'AbortError'
        ? `The voice provider did not respond within ${opts.timeoutMs ?? config.provider.timeoutMs}ms.`
        : `Could not reach the voice provider: ${lastError instanceof Error ? lastError.message : 'unknown transport error'}`;
    throw new ApiError(504, 'upstream_unavailable', message);
  }

  private async send<T>(
    method: string,
    url: string,
    opts: ProviderRequestOptions,
  ): Promise<ProviderResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.provider.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'VoiceKernel/1.0',
      ...opts.headers,
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    // Only the two body shapes we actually send; avoids depending on the DOM
    // lib just for BodyInit.
    let payload: string | FormData | undefined;
    if (opts.formData) {
      // fetch sets the multipart boundary itself; setting it manually breaks parsing.
      payload = opts.formData;
    } else if (opts.body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    try {
      const started = Date.now();
      const res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
      const raw = await res.text();
      const ms = Date.now() - started;

      let data: unknown = null;
      if (raw) {
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
        } else {
          data = raw;
        }
      }

      logger.debug({ method, url: redactUrl(url), status: res.status, ms }, 'provider request');

      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k.toLowerCase()] = v;
      });

      return { status: res.status, data: data as T, headers: outHeaders };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(this.baseUrl + clean);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /** Exponential backoff with full jitter, capped, honouring Retry-After. */
  private backoff(attempt: number, retryAfter?: string): number {
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 20_000);
    }
    const base = Math.min(500 * 2 ** attempt, 8_000);
    return Math.floor(Math.random() * base) + 100;
  }

  // Convenience wrappers -----------------------------------------------------

  get<T = unknown>(path: string, query?: Record<string, unknown>) {
    return this.request<T>({ method: 'GET', path, query });
  }
  post<T = unknown>(path: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>({ method: 'POST', path, body, idempotencyKey });
  }
  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>({ method: 'PATCH', path, body });
  }
  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>({ method: 'PUT', path, body });
  }
  delete<T = unknown>(path: string) {
    return this.request<T>({ method: 'DELETE', path });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
