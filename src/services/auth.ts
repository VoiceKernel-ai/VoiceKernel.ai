import jwt from 'jsonwebtoken';
import { config } from '../config';
import { query, queryOne, transaction } from '../db';
import { ApiError } from '../errors';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { createOrg, type OrganizationRow } from './org';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  status: string;
  last_login_at: Date | null;
  created_at: Date;
}

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

/** Ranked so a permission check is a comparison, not a set lookup. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessTokenClaims {
  sub: string;
  orgId: string;
  role: Role;
  email: string;
}

export async function signup(params: {
  email: string;
  password: string;
  name?: string;
  organizationName?: string;
}): Promise<{ user: UserRow; org: OrganizationRow; role: Role }> {
  if (!config.allowSignup) {
    throw ApiError.forbidden('Self-serve signup is disabled on this deployment.');
  }
  const email = normaliseEmail(params.email);
  if (params.password.length < 12) {
    throw ApiError.badRequest('Password must be at least 12 characters.');
  }

  const existing = await queryOne(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (existing) throw ApiError.conflict('An account with that email already exists.');

  const passwordHash = await hashPassword(params.password);
  const org = await createOrg({ name: params.organizationName || `${email.split('@')[0]}'s org` });

  return transaction(async (client) => {
    const userResult = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *`,
      [email, passwordHash, params.name ?? null],
    );
    const user = userResult.rows[0];
    await client.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [org.id, user.id],
    );
    return { user, org, role: 'owner' as Role };
  });
}

export async function login(email: string, password: string): Promise<UserRow> {
  const user = await queryOne<UserRow>(`SELECT * FROM users WHERE email = $1`, [
    normaliseEmail(email),
  ]);

  // Hash even when the user is missing, so a timing difference does not reveal
  // which emails are registered.
  if (!user) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$3f3sWx0GqEqBqxJq6M0m1QqQ0Vv3q1p9nq3Fm5Kx0Ac',
      password,
    );
    throw ApiError.unauthorized('Incorrect email or password.');
  }
  if (user.status !== 'active') throw ApiError.forbidden('This account is disabled.');

  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) throw ApiError.unauthorized('Incorrect email or password.');

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  return user;
}

/** The org a user lands in by default: their oldest membership. */
export async function primaryMembership(
  userId: string,
): Promise<{ org: OrganizationRow; role: Role } | null> {
  const row = await queryOne<OrganizationRow & { role: Role }>(
    `SELECT o.*, m.role FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND o.status != 'deleted'
      ORDER BY m.created_at ASC
      LIMIT 1`,
    [userId],
  );
  if (!row) return null;
  const { role, ...org } = row;
  return { org: org as OrganizationRow, role };
}

export async function membershipFor(
  userId: string,
  orgId: string,
): Promise<{ org: OrganizationRow; role: Role } | null> {
  const row = await queryOne<OrganizationRow & { role: Role }>(
    `SELECT o.*, m.role FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND o.status != 'deleted'`,
    [userId, orgId],
  );
  if (!row) return null;
  const { role, ...org } = row;
  return { org: org as OrganizationRow, role };
}

export async function listUserOrgs(
  userId: string,
): Promise<Array<{ id: string; name: string; slug: string; role: Role }>> {
  return query(
    `SELECT o.id, o.name, o.slug, m.role FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND o.status != 'deleted'
      ORDER BY m.created_at ASC`,
    [userId],
  );
}

export async function issueTokens(claims: AccessTokenClaims): Promise<SessionTokens> {
  const accessToken = jwt.sign(claims, config.jwtSecret, {
    expiresIn: config.accessTokenTtlSeconds,
    issuer: 'voicekernel',
    audience: 'voicekernel-console',
  });

  // The refresh token is random, not a JWT: it must be revocable server-side.
  const refreshToken = randomToken(32);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [claims.sub, sha256(refreshToken), String(config.refreshTokenTtlSeconds)],
  );

  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, config.jwtSecret, {
      issuer: 'voicekernel',
      audience: 'voicekernel-console',
    }) as AccessTokenClaims;
  } catch {
    throw ApiError.unauthorized('Session expired or invalid. Sign in again.');
  }
}

/**
 * Rotates a refresh token. The old token is revoked in the same statement that
 * validates it, so a replayed token cannot mint a second session.
 */
export async function rotateRefreshToken(
  refreshToken: string,
): Promise<{ userId: string } | null> {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(refreshToken)],
  );
  return row ? { userId: row.user_id } : null;
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256(refreshToken)],
  );
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}
