import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from '../config';
import { ApiError } from '../errors';
import { clientIp } from './context';

/**
 * In-process sliding-window rate limiter, keyed per credential.
 *
 * Deliberately not distributed: a single instance is the common deployment,
 * and a shared Redis counter would put a network hop in front of every request
 * to solve a problem most operators do not yet have. When several instances run
 * behind a load balancer, each enforces its own share of the budget - the
 * effective limit is `max * instances`, which is documented rather than hidden.
 * Swap in a Redis-backed store here if you need an exact global ceiling.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

// Bounded sweep so an unbounded key space (per-IP on public routes) cannot grow
// into a memory leak.
const SWEEP_INTERVAL_MS = 60_000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  /** Distinguishes independent budgets, e.g. "auth" vs "api". */
  bucket?: string;
  keyFn?: (req: Request) => string;
}

export function rateLimit(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const prefix = options.bucket ?? 'api';

  return (req: Request, res: Response, next: NextFunction) => {
    const identity =
      options.keyFn?.(req) ??
      // Prefer the credential: two tenants behind one corporate NAT must not
      // consume each other's budget.
      (req.apiKey?.id ? `key:${req.apiKey.id}` : req.user?.id ? `user:${req.user.id}` : `ip:${clientIp(req)}`);

    const key = `${prefix}:${identity}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      setRateHeaders(res, max, max - 1, now + windowMs);
      return next();
    }

    existing.count += 1;
    const remaining = Math.max(max - existing.count, 0);
    setRateHeaders(res, max, remaining, existing.resetAt);

    if (existing.count > max) {
      const retryAfter = Math.max(Math.ceil((existing.resetAt - now) / 1000), 1);
      res.setHeader('Retry-After', String(retryAfter));
      return next(
        ApiError.rateLimited(
          `Rate limit of ${max} requests per ${Math.round(windowMs / 1000)}s exceeded. Retry in ${retryAfter}s.`,
        ),
      );
    }
    next();
  };
}

function setRateHeaders(res: Response, limit: number, remaining: number, resetAt: number): void {
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

/** Test hook - clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
