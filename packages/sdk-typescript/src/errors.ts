/**
 * Error types mirroring the API's envelope.
 *
 * The server always answers a failure as
 *   { error: { type, code, message, requestId, details? } }
 * so the SDK can give integrators a typed error with the request id attached - * which is the first thing support will ask for.
 */

export interface ApiErrorBody {
  type?: string;
  code?: string;
  message?: string;
  requestId?: string;
  details?: unknown;
  upstream?: unknown;
}

export class VoiceKernelError extends Error {
  /** HTTP status returned by the API. */
  readonly status: number;
  /** Stable machine code, e.g. "rate_limit_exceeded". */
  readonly code: string;
  /** Broad category, e.g. "authentication_error". */
  readonly type: string;
  /** Correlates with server logs. Quote this when reporting a problem. */
  readonly requestId?: string;
  readonly details?: unknown;
  /** Present when the failure originated in the upstream voice provider. */
  readonly upstream?: unknown;

  constructor(status: number, body: ApiErrorBody, fallbackMessage: string) {
    super(body.message ?? fallbackMessage);
    this.name = 'VoiceKernelError';
    this.status = status;
    this.code = body.code ?? 'unknown_error';
    this.type = body.type ?? 'api_error';
    this.requestId = body.requestId;
    this.details = body.details;
    this.upstream = body.upstream;
  }

  /** True when retrying the same request later could succeed. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** The monthly budget is exhausted; outbound is paused, inbound is not. */
  get isBudgetError(): boolean {
    return this.status === 402;
  }
}

/** Raised when the API could not be reached at all. */
export class VoiceKernelConnectionError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceKernelConnectionError';
    this.cause = cause;
  }
}
