import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError } from '../errors';
import { asyncHandler } from './context';
import { authenticateApiKey, scopeSatisfied } from '../services/apikeys';
import {
  membershipFor,
  primaryMembership,
  roleAtLeast,
  verifyAccessToken,
  type Role,
} from '../services/auth';
import { queryOne } from '../db';
import type { UserRow } from '../services/auth';

/**
 * Extracts a bearer credential. Both `Authorization: Bearer <k>` and
 * `X-API-Key: <k>` are accepted - the former is what SDKs send, the latter is
 * what most enterprise API gateways are configured to forward.
 */
function extractCredential(req: Request): string | null {
  const header = req.header('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const apiKeyHeader = req.header('x-api-key');
  if (apiKeyHeader) return apiKeyHeader.trim();
  return null;
}

/**
 * Authenticates machine traffic on /v1. Only VoiceKernel API keys are accepted
 * here; console sessions use `requireSession` instead. Keeping the two apart
 * means a stolen browser token cannot drive the machine API and vice versa.
 */
export function requireApiKey(requiredScope?: string): RequestHandler {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const credential = extractCredential(req);
    if (!credential) {
      throw ApiError.unauthorized(
        'Provide your VoiceKernel API key as "Authorization: Bearer vk_live_…".',
      );
    }

    const authed = await authenticateApiKey(credential);
    if (!authed) throw ApiError.unauthorized('That API key is not valid, or has been revoked.');

    if (requiredScope && !scopeSatisfied(authed.key.scopes, requiredScope)) {
      throw ApiError.forbidden(
        `This API key lacks the "${requiredScope}" scope. Granted: ${authed.key.scopes.join(', ')}.`,
      );
    }

    req.org = authed.org;
    req.apiKey = authed.key;
    req.actor = {
      type: 'api_key',
      id: authed.key.id,
      label: authed.key.name,
      scopes: authed.key.scopes,
      // A key acts with full write authority within its scopes; role gating is
      // a console concept, not a machine-API one.
      role: 'admin',
    };
    next();
  });
}

/**
 * Accepts either an API key or a console session. Used by endpoints the
 * dashboard and integrators both call (agents, calls, analytics).
 */
export function requireAuth(requiredScope?: string): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const credential = extractCredential(req) ?? req.cookies?.vk_session;
    if (!credential) {
      throw ApiError.unauthorized('Authentication required.');
    }

    // VoiceKernel API keys are self-identifying, so there is no ambiguity about
    // which verifier to run.
    if (credential.startsWith('vk_live_') || credential.startsWith('vk_test_')) {
      return requireApiKey(requiredScope)(req, res, next);
    }
    return requireSession()(req, res, next);
  });
}

/** Authenticates a console session JWT and resolves the active organization. */
export function requireSession(minimumRole: Role = 'viewer'): RequestHandler {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractCredential(req) ?? req.cookies?.vk_session;
    if (!token) throw ApiError.unauthorized('Sign in to continue.');

    const claims = verifyAccessToken(token);

    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE id = $1`, [claims.sub]);
    if (!user || user.status !== 'active') {
      throw ApiError.unauthorized('This account is no longer active.');
    }

    // An org may be switched per-request via header; the membership is always
    // re-checked rather than trusted from the token.
    const requestedOrg = req.header('x-voicekernel-org') ?? claims.orgId;
    const membership =
      (await membershipFor(user.id, requestedOrg)) ?? (await primaryMembership(user.id));

    if (!membership) throw ApiError.forbidden('You do not belong to any organization.');
    if (!roleAtLeast(membership.role, minimumRole)) {
      throw ApiError.forbidden(
        `This action requires the "${minimumRole}" role or higher; you have "${membership.role}".`,
      );
    }

    req.user = user;
    req.org = membership.org;
    req.actor = {
      type: 'user',
      id: user.id,
      label: user.email,
      scopes: ['*'],
      role: membership.role,
    };
    next();
  });
}

/** Guards console-only mutations behind a role, after requireSession ran. */
export function requireRole(minimumRole: Role): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(ApiError.unauthorized());
    if (req.actor.type === 'api_key') return next();
    if (!roleAtLeast(req.actor.role, minimumRole)) {
      return next(
        ApiError.forbidden(
          `This action requires the "${minimumRole}" role or higher; you have "${req.actor.role}".`,
        ),
      );
    }
    next();
  };
}

/** Asserts a scope on a route already authenticated by requireAuth. */
export function requireScope(scope: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(ApiError.unauthorized());
    if (!scopeSatisfied(req.actor.scopes, scope)) {
      return next(ApiError.forbidden(`This credential lacks the "${scope}" scope.`));
    }
    next();
  };
}

export function currentOrg(req: Request) {
  if (!req.org) throw ApiError.unauthorized('No organization resolved for this request.');
  return req.org;
}
