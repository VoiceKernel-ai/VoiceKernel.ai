import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/context';
import { requireSession } from '../middleware/auth';
import { rateLimit } from '../middleware/ratelimit';
import { config } from '../config';
import { ApiError } from '../errors';
import {
  issueTokens,
  listUserOrgs,
  login,
  membershipFor,
  primaryMembership,
  publicUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signup,
} from '../services/auth';
import { publicOrg } from '../services/org';
import { queryOne } from '../db';
import type { UserRow } from '../services/auth';

/**
 * Console authentication.
 *
 * Sessions are a browser concept and stay separate from API keys: the access
 * token is a short-lived JWT, the refresh token is opaque and revocable, and
 * both are set as httpOnly cookies so console JS never handles them.
 */
export const authRouter = Router();

// Credential endpoints get a tighter budget than the rest of the API - this is
// where brute force shows up.
const authLimit = rateLimit({ bucket: 'auth', windowMs: 60_000, max: 20 });

function setSessionCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
): void {
  const secure = config.isProd;
  res.cookie('vk_session', tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: tokens.expiresIn * 1000,
    path: '/',
  });
  res.cookie('vk_refresh', tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: config.refreshTokenTtlSeconds * 1000,
    // Scoped to the refresh endpoint so it is not attached to every request.
    path: '/auth/refresh',
  });
}

authRouter.post(
  '/signup',
  authLimit,
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        email: z.string().email(),
        password: z.string().min(12, 'Password must be at least 12 characters.'),
        name: z.string().max(120).optional(),
        organizationName: z.string().max(200).optional(),
      })
      .parse(req.body ?? {});

    const { user, org, role } = await signup(input);
    const tokens = await issueTokens({
      sub: user.id,
      orgId: org.id,
      role,
      email: user.email,
    });
    setSessionCookies(res, tokens);

    res.status(201).json({
      user: publicUser(user),
      organization: publicOrg(org),
      role,
      ...tokens,
    });
  }),
);

authRouter.post(
  '/login',
  authLimit,
  asyncHandler(async (req, res) => {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body ?? {});

    const user = await login(email, password);
    const membership = await primaryMembership(user.id);
    if (!membership) throw ApiError.forbidden('This account does not belong to an organization.');

    const tokens = await issueTokens({
      sub: user.id,
      orgId: membership.org.id,
      role: membership.role,
      email: user.email,
    });
    setSessionCookies(res, tokens);

    res.json({
      user: publicUser(user),
      organization: publicOrg(membership.org),
      role: membership.role,
      ...tokens,
    });
  }),
);

authRouter.post(
  '/refresh',
  authLimit,
  asyncHandler(async (req, res) => {
    const presented =
      (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null) ??
      req.cookies?.vk_refresh;
    if (!presented) throw ApiError.unauthorized('No refresh token supplied.');

    // Rotation revokes the presented token as it validates it, so a replay of
    // the old value cannot mint a second live session.
    const rotated = await rotateRefreshToken(presented);
    if (!rotated) throw ApiError.unauthorized('That refresh token is expired or already used.');

    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE id = $1`, [rotated.userId]);
    if (!user || user.status !== 'active') throw ApiError.unauthorized('Account is not active.');

    const membership = await primaryMembership(user.id);
    if (!membership) throw ApiError.forbidden('This account does not belong to an organization.');

    const tokens = await issueTokens({
      sub: user.id,
      orgId: membership.org.id,
      role: membership.role,
      email: user.email,
    });
    setSessionCookies(res, tokens);

    res.json({ user: publicUser(user), organization: publicOrg(membership.org), ...tokens });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const presented = req.cookies?.vk_refresh;
    if (presented) await revokeRefreshToken(presented);
    res.clearCookie('vk_session', { path: '/' });
    res.clearCookie('vk_refresh', { path: '/auth/refresh' });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireSession(),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    res.json({
      user: publicUser(user),
      organization: publicOrg(req.org!),
      role: req.actor!.role,
      organizations: await listUserOrgs(user.id),
    });
  }),
);

/** Switches the active organization, re-checking membership before issuing. */
authRouter.post(
  '/switch-org',
  requireSession(),
  asyncHandler(async (req, res) => {
    const { organizationId } = z.object({ organizationId: z.string().uuid() }).parse(req.body ?? {});

    const membership = await membershipFor(req.user!.id, organizationId);
    if (!membership) throw ApiError.forbidden('You are not a member of that organization.');

    const tokens = await issueTokens({
      sub: req.user!.id,
      orgId: membership.org.id,
      role: membership.role,
      email: req.user!.email,
    });
    setSessionCookies(res, tokens);

    res.json({ organization: publicOrg(membership.org), role: membership.role, ...tokens });
  }),
);
