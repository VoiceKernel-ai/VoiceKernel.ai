/**
 * Creates a workable tenant so a fresh clone has something to sign in to.
 *
 * Idempotent: re-running reuses the existing account rather than failing, but
 * always issues a fresh API key (the old plaintext is unrecoverable by design).
 *
 *   npm run seed
 */
import { randomBytes } from 'node:crypto';
import { closePool, queryOne } from '../src/db';
import { hashPassword } from '../src/lib/crypto';
import { createOrg } from '../src/services/org';
import { createApiKey } from '../src/services/apikeys';
import { createEndpoint } from '../src/services/webhooks';
import type { UserRow } from '../src/services/auth';

const EMAIL = process.env.SEED_EMAIL ?? 'admin@voicekernel.local';

/**
 * A fixed default here would ship a working credential in a public repository,
 * and every deployment that ran `npm run seed` without thinking about it would
 * share the same admin password. Generated per run instead, and printed once -
 * there is nowhere to look it up afterwards, which is the point.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? `vk-${randomBytes(12).toString('hex')}`;
const PASSWORD_WAS_GENERATED = !process.env.SEED_PASSWORD;

const ORG_NAME = process.env.SEED_ORG ?? 'Example Org';

async function main(): Promise<void> {
  let user = await queryOne<UserRow>(`SELECT * FROM users WHERE email = $1`, [EMAIL]);
  let orgId: string;

  if (user) {
    const membership = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [user.id],
    );
    if (!membership) throw new Error('Seed user exists but has no organization.');
    orgId = membership.org_id;
    console.log(`Reusing existing account ${EMAIL}`);
  } else {
    const org = await createOrg({ name: ORG_NAME, region: 'au-syd' });
    orgId = org.id;

    user = await queryOne<UserRow>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *`,
      [EMAIL, await hashPassword(PASSWORD), 'VoiceKernel Admin'],
    );
    if (!user) throw new Error('Could not create seed user.');

    await queryOne(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`,
      [orgId, user.id],
    );
    console.log(`Created organization "${ORG_NAME}" and owner ${EMAIL}`);
  }

  const { plaintext } = await createApiKey({
    orgId,
    name: 'Seed key',
    environment: 'live',
    scopes: ['*'],
    createdBy: user.id,
  });

  // A request-bin style endpoint so the webhook queue has somewhere to go in
  // development; harmless if unreachable, deliveries simply retry then die.
  const existingHook = await queryOne(
    `SELECT id FROM webhook_endpoints WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (!existingHook) {
    await createEndpoint({
      orgId,
      url: 'https://example.com/voicekernel-webhook',
      description: 'Example endpoint - replace with your own.',
      events: ['*'],
    });
  }

  console.log('\n────────────────────────────────────────────────────');
  console.log('  Console:      http://localhost:8080/app');
  console.log(`  Email:        ${EMAIL}`);
  console.log(`  Password:     ${PASSWORD}${PASSWORD_WAS_GENERATED ? '   <- generated, not stored anywhere' : ''}`);
  console.log(`  Organization: ${orgId}`);
  console.log(`  API key:      ${plaintext}`);
  console.log('────────────────────────────────────────────────────');
  console.log('\n  Try it:');
  console.log(`    curl -H "Authorization: Bearer ${plaintext}" http://localhost:8080/v1/agents\n`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exit(1);
  });
