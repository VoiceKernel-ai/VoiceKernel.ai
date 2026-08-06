/**
 * A single error shape across the whole API, modelled on the error envelopes
 * enterprise integrators already parse (Stripe-style): a stable machine `code`,
 * a human `message`, and optional structured `details`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Set when the failure originated inside the provider rather than VoiceKernel. */
  readonly upstream?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; upstream?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.upstream = options.upstream;
  }

  toJSON() {
    return {
      error: {
        type: httpStatusToType(this.status),
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(this.upstream !== undefined ? { upstream: this.upstream } : {}),
      },
    };
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'invalid_request', message, { details });
  }
  static unauthorized(message = 'Missing or invalid credentials.') {
    return new ApiError(401, 'unauthenticated', message);
  }
  static forbidden(message = 'You do not have access to this resource.') {
    return new ApiError(403, 'permission_denied', message);
  }
  static notFound(message = 'Resource not found.') {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'conflict', message, { details });
  }
  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, 'unprocessable_entity', message, { details });
  }
  static rateLimited(message = 'Rate limit exceeded.') {
    return new ApiError(429, 'rate_limit_exceeded', message);
  }
  static internal(message = 'An unexpected error occurred.', details?: unknown) {
    return new ApiError(500, 'internal_error', message, { details });
  }
  static notConfigured(message: string) {
    return new ApiError(503, 'not_configured', message);
  }
}

function httpStatusToType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 402) return 'billing_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 409) return 'conflict_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

/** Raised when the provider itself returns a non-2xx. Preserves the upstream body. */
export class ProviderError extends ApiError {
  readonly providerStatus: number;

  constructor(status: number, body: unknown, message?: string) {
    // Upstream 5xx means the voice provider is unhealthy, which is a 502 for our callers, not
    // a 500 - the distinction matters when an integrator is debugging.
    const mapped = status >= 500 ? 502 : status;
    super(mapped, status >= 500 ? 'upstream_error' : 'upstream_rejected', message ?? extractMessage(body, status), {
      upstream: body,
    });
    this.name = 'ProviderError';
    this.providerStatus = status;
  }
}

function extractMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const m = b.message ?? b.error ?? b.detail;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.filter((x) => typeof x === 'string').join('; ') || `The voice provider returned ${status}.`;
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 500);
  return `The voice provider returned ${status}.`;
}
