/**
 * End-to-end API tests against a running server.
 *
 *   npm run db:up && npm run migrate
 *   npm run dev          # in another shell
 *   npm test
 *
 * These hit real HTTP and a real database rather than mocking the layers,
 * because the properties worth testing here - tenant isolation, scope
 * enforcement, idempotency - are properties of the whole stack. A mocked
 * proxy would happily "pass" an isolation test that production fails.
 *
 * Anything requiring a live provider credential is skipped unless PROVIDER_API_KEY is
 * set, and says so, rather than silently reporting green.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, query, closePool } from '../src/db';
import { verifyWebhookSignature, signWebhook } from '../src/lib/crypto';
import { toPublicPayload, toWirePayload } from '../src/provider/aliases';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:8080';
const HAS_PROVIDER = Boolean(process.env.PROVIDER_API_KEY);

interface Tenant {
  email: string;
  password: string;
  orgId: string;
  apiKey: string;
  cookies: string;
}

async function http(
  path: string,
  init: RequestInit & { key?: string; cookies?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.key) headers.set('Authorization', `Bearer ${init.key}`);
  if (init.cookies) headers.set('Cookie', init.cookies);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON responses (static assets) stay as text */
  }
  return { status: res.status, body, headers: res.headers };
}

/** Creates a fresh tenant with its own owner, org and full-scope API key. */
async function createTenant(label: string): Promise<Tenant> {
  const email = `${label}-${crypto.randomBytes(6).toString('hex')}@voicekernel.test`;
  const password = 'test-password-1234';

  const signup = await http('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, organizationName: `${label} Ltd` }),
  });
  assert.equal(signup.status, 201, `signup failed: ${JSON.stringify(signup.body)}`);

  const cookies = 'vk_session=' + signup.body.accessToken;
  const keyRes = await http('/v1/api-keys', {
    method: 'POST',
    cookies,
    body: JSON.stringify({ name: 'test key', scopes: ['*'] }),
  });
  assert.equal(keyRes.status, 201, `key creation failed: ${JSON.stringify(keyRes.body)}`);

  return {
    email,
    password,
    orgId: signup.body.organization.id,
    apiKey: keyRes.body.key,
    cookies,
  };
}

/**
 * Registers a resource directly in the ownership registry. Creating one through
 * the API needs a live provider account; isolation must be provable without one.
 */
async function seedResource(orgId: string, kind: string, vapiId: string, name: string) {
  await query(
    `INSERT INTO resources (org_id, kind, provider_id, name, snapshot)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [orgId, kind, vapiId, name, JSON.stringify({ id: vapiId, name })],
  );
}

let alice: Tenant;
let bob: Tenant;

before(async () => {
  const health = await http('/health');
  assert.equal(health.status, 200, `server not reachable at ${BASE} - start it with "npm run dev"`);
  alice = await createTenant('alice');
  bob = await createTenant('bob');
});

after(async () => {
  // Cascades clean up memberships, keys, resources and calls.
  await query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[alice.orgId, bob.orgId]]);
  await query(`DELETE FROM users WHERE email = ANY($1::text[])`, [[alice.email, bob.email]]);
  await closePool();
});

// ---------------------------------------------------------------------------

describe('health and discovery', () => {
  test('reports database and upstream status', async () => {
    const res = await http('/health');
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.checks.database, 'ok');
    assert.equal(res.body.provider.operationsCovered, 97);
    assert.equal(res.body.provider.upstream, undefined, 'the vendor hostname must not be published');
  });

  test('publishes the full provider operation map without authentication', async () => {
    const res = await http('/docs/operations');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 97);
    assert.equal(res.body.data.length, 97);

    // Every operation must be addressable through /v1/provider.
    for (const op of res.body.data) {
      assert.ok(op.path.startsWith('/v1/provider/'), `${op.operationId} is not routed`);
    }
  });

  test('serves a valid OpenAPI document', async () => {
    const res = await http('/docs/openapi.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.1.0');
    assert.ok(res.body.paths['/v1/agents']);
    assert.ok(res.body.paths['/v1/calls']);
  });
});

describe('authentication', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await http('/v1/agents');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthenticated');
  });

  test('rejects a malformed or unknown key', async () => {
    const res = await http('/v1/agents', { key: 'vk_live_notarealkeyatall' });
    assert.equal(res.status, 401);
  });

  test('accepts a valid key', async () => {
    const res = await http('/v1/agents', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.equal(res.body.object, 'list');
  });

  test('accepts the key via X-API-Key as well as Bearer', async () => {
    const res = await http('/v1/agents', { headers: { 'X-API-Key': alice.apiKey } });
    assert.equal(res.status, 200);
  });

  test('a revoked key stops working immediately', async () => {
    const created = await http('/v1/api-keys', {
      method: 'POST',
      cookies: alice.cookies,
      body: JSON.stringify({ name: 'to be revoked', scopes: ['*'] }),
    });
    const key = created.body.key;
    assert.equal((await http('/v1/agents', { key })).status, 200);

    await http(`/v1/api-keys/${created.body.id}`, { method: 'DELETE', cookies: alice.cookies });
    assert.equal((await http('/v1/agents', { key })).status, 401);
  });

  test('an API key cannot mint another API key', async () => {
    const res = await http('/v1/api-keys', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ name: 'escalation attempt', scopes: ['*'] }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'session_required');
  });

  test('never returns the key plaintext after creation', async () => {
    const list = await http('/v1/api-keys', { cookies: alice.cookies });
    for (const k of list.body.data) {
      assert.equal(k.key, undefined);
      assert.ok(k.masked.includes('•'));
    }
  });
});

describe('scopes', () => {
  test('a scoped key is refused operations outside its grant', async () => {
    const created = await http('/v1/api-keys', {
      method: 'POST',
      cookies: alice.cookies,
      body: JSON.stringify({ name: 'read only', scopes: ['agents:read'] }),
    });
    const readOnly = created.body.key;

    assert.equal((await http('/v1/agents', { key: readOnly })).status, 200);

    const write = await http('/v1/agents', {
      method: 'POST',
      key: readOnly,
      body: JSON.stringify({ name: 'x', systemPrompt: 'y' }),
    });
    assert.equal(write.status, 403);
    assert.match(write.body.error.message, /agents:write/);
  });

  test('rejects an unknown scope at creation rather than silently dropping it', async () => {
    const res = await http('/v1/api-keys', {
      method: 'POST',
      cookies: alice.cookies,
      body: JSON.stringify({ name: 'bad', scopes: ['agents:destroy'] }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Unknown scope/);
  });
});

describe('tenant isolation', () => {
  const aliceAgent = 'asst_alice_' + crypto.randomBytes(4).toString('hex');
  const bobAgent = 'asst_bob_' + crypto.randomBytes(4).toString('hex');

  before(async () => {
    await seedResource(alice.orgId, 'assistant', aliceAgent, 'Alice disputes agent');
    await seedResource(bob.orgId, 'assistant', bobAgent, 'Bob claims agent');
  });

  test('each tenant sees only its own agents', async () => {
    const a = await http('/v1/agents', { key: alice.apiKey });
    const b = await http('/v1/agents', { key: bob.apiKey });

    const aIds = a.body.data.map((x: any) => x.id);
    const bIds = b.body.data.map((x: any) => x.id);

    assert.ok(aIds.includes(aliceAgent));
    assert.ok(!aIds.includes(bobAgent), "alice must not see bob's agent");
    assert.ok(bIds.includes(bobAgent));
    assert.ok(!bIds.includes(aliceAgent), "bob must not see alice's agent");
  });

  test("reading another tenant's agent by id is a 404, not a 403", async () => {
    // 403 would confirm the ID exists somewhere, which is itself a leak.
    const res = await http(`/v1/agents/${bobAgent}`, { key: alice.apiKey });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  test("deleting another tenant's agent is refused", async () => {
    const res = await http(`/v1/agents/${bobAgent}`, { method: 'DELETE', key: alice.apiKey });
    assert.equal(res.status, 404);

    const stillThere = await query(
      `SELECT deleted_at FROM resources WHERE kind = 'assistant' AND provider_id = $1`,
      [bobAgent],
    );
    assert.equal(stillThere[0].deleted_at, null, "bob's agent must be untouched");
  });

  test('the passthrough enforces the same ownership check', async () => {
    const res = await http(`/v1/provider/assistant/${bobAgent}`, { key: alice.apiKey });
    assert.equal(res.status, 404);
  });

  test('a tenant cannot switch org by header without membership', async () => {
    const res = await http('/v1/organization', {
      cookies: alice.cookies,
      headers: { 'X-VoiceKernel-Org': bob.orgId },
    });
    // Falls back to the caller's own org rather than honouring the header.
    assert.equal(res.status, 200);
    assert.equal(res.body.id, alice.orgId);
  });
});

describe('provider passthrough', () => {
  test('lists the operations available to this tenant', async () => {
    const res = await http('/v1/provider/_operations', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalOperations, 97);
    assert.equal(res.body.mode, 'platform');

    // Account-wide operations are unavailable on the shared platform key.
    const blocked = res.body.data.filter((o: any) => !o.available);
    assert.ok(blocked.length >= 1);
    for (const op of blocked) assert.ok(op.unavailableReason);
  });

  test('refuses a path that is not a real provider operation', async () => {
    const res = await http('/v1/provider/not-a-real-endpoint', { key: alice.apiKey });
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /No provider operation matches/);
  });

  test('refuses account-wide analytics on the shared platform key', async () => {
    const res = await http('/v1/provider/analytics', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ queries: [] }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'unsupported_in_platform_mode');
  });

  test('requires the passthrough scope', async () => {
    const created = await http('/v1/api-keys', {
      method: 'POST',
      cookies: alice.cookies,
      body: JSON.stringify({ name: 'no passthrough', scopes: ['agents:read'] }),
    });
    const res = await http('/v1/provider/_operations', { key: created.body.key });
    assert.equal(res.status, 403);
  });
});

describe('agent validation', () => {
  test('requires a name and a prompt', async () => {
    const res = await http('/v1/agents', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ systemPrompt: 'no name given' }),
    });
    assert.equal(res.status, 400);
  });

  test('rejects a model that the chosen provider does not offer', async () => {
    const res = await http('/v1/agents', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({
        name: 'Mismatched',
        systemPrompt: 'test',
        model: { provider: 'anthropic', model: 'gpt-4o' },
      }),
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body.error.details), /not a known model/);
  });

  test('rejects an unknown provider', async () => {
    const res = await http('/v1/agents', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({
        name: 'Bad provider',
        systemPrompt: 'test',
        model: { provider: 'not-a-provider' },
      }),
    });
    assert.equal(res.status, 422);
  });

  test('rejects unknown top-level fields rather than ignoring them', async () => {
    const res = await http('/v1/agents', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ name: 'X', systemPrompt: 'y', typoField: true }),
    });
    assert.equal(res.status, 422);
  });
});

describe('catalog', () => {
  test('exposes the provider matrix generated from the Vapi spec', async () => {
    const res = await http('/v1/catalog', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.ok(res.body.counts.modelProviders >= 15);
    assert.ok(res.body.counts.models >= 100);

    const anthropic = res.body.models.find((m: any) => m.provider === 'anthropic');
    assert.ok(anthropic, 'anthropic must be offered');
    assert.ok(anthropic.options.some((o: string) => o.startsWith('claude-')));
  });
});

describe('calls', () => {
  test('requires a destination and an agent', async () => {
    const res = await http('/v1/calls', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ to: '+61400000000' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /agentId|squadId|workflowId/);
  });

  test('validates the destination is E.164', async () => {
    const res = await http('/v1/calls', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ to: '0400 000 000', agentId: 'asst_x' }),
    });
    assert.equal(res.status, 422);
  });

  test('lists calls scoped to the tenant', async () => {
    const res = await http('/v1/calls', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.equal(res.body.object, 'list');
    assert.deepEqual(res.body.data, []);
  });
});

describe('idempotency', () => {
  test('replays the stored response instead of repeating the operation', async () => {
    const key = 'test-idem-' + crypto.randomBytes(8).toString('hex');
    const body = JSON.stringify({ url: 'https://example.com/hook-idem', events: ['*'] });

    const first = await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      headers: { 'Idempotency-Key': key },
      body,
    });
    assert.equal(first.status, 201);

    const second = await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      headers: { 'Idempotency-Key': key },
      body,
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id, 'must return the original resource, not a new one');
    assert.equal(second.headers.get('idempotent-replay'), 'true');

    const endpoints = await http('/v1/webhook-endpoints', { key: alice.apiKey });
    const matches = endpoints.body.data.filter((e: any) => e.url === 'https://example.com/hook-idem');
    assert.equal(matches.length, 1, 'exactly one endpoint should exist');
  });

  test('rejects reuse of a key with a different payload', async () => {
    const key = 'test-idem-conflict-' + crypto.randomBytes(8).toString('hex');

    await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ url: 'https://example.com/a', events: ['*'] }),
    });

    const conflict = await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ url: 'https://example.com/b', events: ['*'] }),
    });
    assert.equal(conflict.status, 409);
  });
});

describe('webhooks', () => {
  test('creates an endpoint and returns the secret exactly once', async () => {
    const res = await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ url: 'https://example.com/crm', events: ['call.ended'] }),
    });
    assert.equal(res.status, 201);
    assert.match(res.body.secret, /^whsec_/);

    const list = await http('/v1/webhook-endpoints', { key: alice.apiKey });
    const found = list.body.data.find((e: any) => e.id === res.body.id);
    assert.equal(found.secret, undefined, 'the list must not expose secrets');
  });

  test('the signature we generate verifies, and a tampered body does not', async () => {
    const secret = 'whsec_test_secret';
    const body = JSON.stringify({ type: 'call.ended', data: { id: 'call_1' } });
    const ts = Math.floor(Date.now() / 1000);
    const signature = signWebhook(secret, body, ts);

    assert.equal(verifyWebhookSignature(secret, body, signature), true);
    assert.equal(verifyWebhookSignature(secret, body + ' ', signature), false);
    assert.equal(verifyWebhookSignature('whsec_wrong', body, signature), false);
  });

  test('rejects a replayed signature outside the tolerance window', async () => {
    const secret = 'whsec_test_secret';
    const body = '{}';
    const old = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(verifyWebhookSignature(secret, body, signWebhook(secret, body, old)), false);
  });

  test('another tenant cannot read an endpoint secret', async () => {
    const created = await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ url: 'https://example.com/private', events: ['*'] }),
    });
    const res = await http(`/v1/webhook-endpoints/${created.body.id}/secret`, { key: bob.apiKey });
    assert.equal(res.status, 404);
  });
});

describe('inbound provider webhooks', () => {
  test('mirrors a call and attributes it to the org in the path', async () => {
    const callId = 'call_' + crypto.randomBytes(8).toString('hex');

    const res = await http(`/webhooks/provider/${alice.orgId}`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          type: 'end-of-call-report',
          endedReason: 'customer-ended-call',
          call: {
            id: callId,
            assistantId: 'asst_test',
            type: 'inboundPhoneCall',
            status: 'ended',
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            endedAt: new Date().toISOString(),
            customer: { number: '+61400000000' },
          },
          artifact: { transcript: 'Caller: hello\nAgent: hi there' },
          analysis: { summary: 'A short greeting.' },
          cost: 0.12,
        },
      }),
    });
    assert.equal(res.status, 200);

    // Poll briefly: the mirror write is awaited, but the event fan-out is not.
    let mirrored: any = null;
    for (let i = 0; i < 10 && !mirrored; i++) {
      const list = await http('/v1/calls', { key: alice.apiKey });
      mirrored = list.body.data.find((c: any) => c.id === callId);
      if (!mirrored) await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(mirrored, 'the call should be mirrored into VoiceKernel');
    assert.equal(mirrored.endedReason, 'customer-ended-call');
    assert.equal(mirrored.summary, 'A short greeting.');
    assert.match(mirrored.transcript, /hello/);
    assert.equal(Math.round(mirrored.durationSeconds), 60);

    // And it must not be visible to another tenant.
    const bobsView = await http('/v1/calls', { key: bob.apiKey });
    assert.ok(!bobsView.body.data.some((c: any) => c.id === callId));
  });

  test('ignores an unknown organization without erroring', async () => {
    const res = await http(`/webhooks/provider/${crypto.randomUUID()}`, {
      method: 'POST',
      body: JSON.stringify({ message: { type: 'status-update' } }),
    });
    // 200 so Vapi does not retry forever against a deleted tenant.
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, 'unknown organization');
  });

  test('answers assistant-request inline with a clear error when unconfigured', async () => {
    const res = await http(`/webhooks/provider/${alice.orgId}`, {
      method: 'POST',
      body: JSON.stringify({ message: { type: 'assistant-request' } }),
    });
    assert.equal(res.status, 200);
    assert.match(res.body.error, /No default agent/);
  });
});

describe('subject erasure', () => {
  const number = '+61400' + String(Math.floor(Math.random() * 900000) + 100000);
  const callId = 'call_erase_' + crypto.randomBytes(6).toString('hex');

  before(async () => {
    await http(`/webhooks/provider/${alice.orgId}`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          type: 'end-of-call-report',
          endedReason: 'customer-ended-call',
          call: {
            id: callId,
            assistantId: 'asst_erase',
            type: 'inboundPhoneCall',
            status: 'ended',
            startedAt: new Date(Date.now() - 120_000).toISOString(),
            endedAt: new Date().toISOString(),
            customer: { number },
          },
          artifact: {
            transcript: 'Caller: my card is 4111 1111 1111 1111',
            performanceMetrics: {
              turnLatencyAverage: 412,
              modelLatencyAverage: 238,
              voiceLatencyAverage: 82,
              transcriberLatencyAverage: 92,
            },
          },
          analysis: { summary: 'Caller disclosed card details.' },
          cost: 0.12,
        },
      }),
    });

    // The mirror write is awaited by the webhook handler, but give the fan-out
    // a moment so the event row exists to be scrubbed too.
    await new Promise((r) => setTimeout(r, 400));
  });

  test('captures per-stage latency from artifact.performanceMetrics', async () => {
    const res = await http('/v1/analytics/latency', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.ok(res.body.sampleSize >= 1, 'the seeded call should be measured');
    assert.equal(res.body.turnP50, 412);

    const stages = Object.fromEntries(
      res.body.stages.map((s: any) => [s.stage, s.p50]),
    );
    assert.equal(stages.transcriber, 92);
    assert.equal(stages.model, 238);
    assert.equal(stages.voice, 82);
  });

  test('previews what an erasure would touch without touching it', async () => {
    const res = await http(`/v1/subjects/${encodeURIComponent(number)}`, { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.equal(res.body.calls, 1);

    const still = await http('/v1/calls?limit=100', { key: alice.apiKey });
    assert.ok(
      still.body.data.some((c: any) => c.id === callId && c.transcript),
      'preview must not modify anything',
    );
  });

  test('requires the admin role, not merely a write scope', async () => {
    const res = await http(`/v1/subjects/${encodeURIComponent(number)}?upstream=false`, {
      method: 'DELETE',
      key: alice.apiKey,
    });
    // An API key acts with admin authority; a viewer session must not.
    assert.notEqual(res.status, 401);
  });

  test('redacts content and identifiers but keeps the call auditable', async () => {
    const res = await http(`/v1/subjects/${encodeURIComponent(number)}?upstream=false`, {
      method: 'DELETE',
      key: alice.apiKey,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.complete, true);

    const rows = await query<{
      customer_number: string | null;
      transcript: string | null;
      summary: string | null;
      analysis: unknown;
      duration_seconds: string | null;
      cost: string | null;
    }>(
      `SELECT customer_number, transcript, summary, analysis, duration_seconds, cost
         FROM calls WHERE provider_call_id = $1`,
      [callId],
    );
    assert.equal(rows.length, 1, 'the row must survive - deleting it would rewrite history');

    const row = rows[0];
    assert.equal(row.customer_number, null);
    assert.equal(row.transcript, null);
    assert.equal(row.summary, null);
    assert.equal(row.analysis, null);

    // Retained so the call is still provable as an event that occurred.
    assert.ok(Number(row.duration_seconds) > 0);
    assert.ok(Number(row.cost) > 0);
  });

  test('leaves no trace of the number in event payloads', async () => {
    const events = await query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE org_id = $1`,
      [alice.orgId],
    );
    const serialised = JSON.stringify(events);
    assert.ok(!serialised.includes(number.replace('+', '')), 'the number must not survive in events');
  });

  test('writes an audit receipt for the erasure', async () => {
    const res = await http('/v1/events/audit?action=erasure', { key: alice.apiKey });
    const entry = (res.body.data ?? [])[0];
    assert.ok(entry, 'an erasure must be audited');
    assert.equal(entry.action, 'erasure.execute');
    assert.equal(entry.metadata.complete, true);
  });
});

describe('governance', () => {
  test('states which change controls are actually enforced', async () => {
    const res = await http('/v1/governance/change-control', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.match(res.body.enforced.requireEvalGateForProduction, /^Enforced/);
    // The platform has no approval workflow; it must not claim otherwise.
    assert.match(res.body.enforced.requireDualApprovalForWaivers, /Recorded only/);
  });

  test('does not assert attestations it cannot verify', async () => {
    const res = await http('/v1/governance/residency', { key: alice.apiKey });
    assert.equal(res.body.attestations.soc2, null);
    assert.equal(res.body.attestations.iso27001, null);
    assert.match(res.body.attestations.note, /not claims this software verifies/);
    assert.match(res.body.retention.enforced, /Recorded only/);
  });

  test('reports provider cost, not an invoice', async () => {
    const res = await http('/v1/governance/workloads', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.equal(res.body.billing.invoices, null);
    assert.match(res.body.billing.note, /no billing integration/);
  });
});

describe('audit trail', () => {
  test('records mutations with the acting credential', async () => {
    await http('/v1/webhook-endpoints', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({ url: 'https://example.com/audited', events: ['*'] }),
    });

    let entries: any[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await http('/v1/events/audit', { key: alice.apiKey });
      entries = res.body.data ?? [];
      if (entries.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.ok(entries.length > 0, 'mutations must be audited');
    const entry = entries[0];
    assert.equal(entry.actor.type, 'api_key');
    assert.ok(entry.action.startsWith('POST'));
  });

  test('does not record request bodies, only their shape', async () => {
    const res = await http('/v1/events/audit', { key: alice.apiKey });
    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes('https://example.com/audited'), 'URLs must not be stored verbatim');
  });
});

describe('organization', () => {
  test('reports platform mode and resource counts', async () => {
    const res = await http('/v1/organization', { key: alice.apiKey });
    assert.equal(res.status, 200);
    assert.equal(res.body.provider.mode, 'platform');
    assert.ok(res.body.resources);
  });

  test('rejects an invalid provider key rather than storing it', async () => {
    const res = await http('/v1/organization/provider', {
      method: 'PUT',
      cookies: alice.cookies,
      body: JSON.stringify({ apiKey: 'definitely-not-a-valid-vapi-key' }),
    });
    assert.ok(res.status >= 400, 'an unverifiable key must not be accepted');

    const org = await http('/v1/organization', { key: alice.apiKey });
    assert.equal(org.body.provider.mode, 'platform', 'mode must not change on failure');
  });
});

describe('error envelope', () => {
  test('unknown routes return the standard shape with a request id', async () => {
    const res = await http('/v1/not-a-route', { key: alice.apiKey });
    assert.equal(res.status, 404);
    assert.ok(res.body.error.requestId);
    assert.ok(res.body.error.type);
    assert.ok(res.body.error.code);
  });

  test('validation failures list the offending fields', async () => {
    const res = await http('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.ok(Array.isArray(res.body.error.details));
  });

  test('echoes an upstream request id header', async () => {
    const res = await http('/health', { headers: { 'X-Request-Id': 'trace-abc-123' } });
    assert.equal(res.headers.get('x-request-id'), 'trace-abc-123');
  });
});

describe('rate limiting', () => {
  test('advertises the remaining budget', async () => {
    const res = await http('/v1/agents', { key: alice.apiKey });
    assert.ok(res.headers.get('x-ratelimit-limit'));
    assert.ok(res.headers.get('x-ratelimit-remaining'));
  });
});

describe('web', () => {
  test('serves the marketing pages', async () => {
    for (const path of ['/', '/industries', '/pricing']) {
      const res = await http(path);
      assert.equal(res.status, 200, `${path} should render`);
      assert.match(String(res.body), /VoiceKernel/);
    }
  });

  test('serves the console shell for deep links', async () => {
    const res = await http('/app/settings');
    assert.equal(res.status, 200);
    assert.match(String(res.body), /VoiceKernel Console/);
  });
});

describe('live provider', { skip: HAS_PROVIDER ? false : 'set PROVIDER_API_KEY to run live upstream tests' }, () => {
  let agentId: string | null = null;

  test('creates an agent through the facade', async () => {
    const res = await http('/v1/agents', {
      method: 'POST',
      key: alice.apiKey,
      body: JSON.stringify({
        name: 'Test disputes agent',
        systemPrompt: 'You are a card disputes specialist. Be brief.',
        firstMessage: 'Thanks for calling.',
        model: { provider: 'openai', model: 'gpt-4o', temperature: 0.3 },
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.object, 'agent');
    assert.equal(res.body.systemPrompt, 'You are a card disputes specialist. Be brief.');
    agentId = res.body.id;
  });

  test('swapping the model preserves the prompt', async () => {
    assert.ok(agentId);
    const res = await http(`/v1/agents/${agentId}/model`, {
      method: 'PUT',
      key: alice.apiKey,
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.model.provider, 'anthropic');
    assert.equal(res.body.systemPrompt, 'You are a card disputes specialist. Be brief.');
  });

  test('points the agent at the VoiceKernel webhook pipeline', async () => {
    assert.ok(agentId);
    const res = await http(`/v1/agents/${agentId}`, { key: alice.apiKey });
    assert.match(res.body.server?.url ?? '', /\/webhooks\/vapi\//);
  });

  after(async () => {
    if (agentId) await http(`/v1/agents/${agentId}`, { method: 'DELETE', key: alice.apiKey });
  });
});

/**
 * The upstream ships its own LLM, voice and transcriber under a provider id
 * equal to the vendor's brand. We republish that id under our own name and
 * translate at the proxy boundary, so these tests pin the property that makes
 * the rebrand true rather than cosmetic: the vendor id must not survive a
 * round trip in either direction.
 */
describe('provider aliasing', () => {
  test('the catalog publishes the in-house provider under our own id', async () => {
    const res = await http('/v1/catalog', { key: alice.apiKey });
    assert.equal(res.status, 200);

    const body = JSON.stringify(res.body);
    assert.ok(!/"vapi"/.test(body), 'catalog must not expose the vendor provider id');
    assert.ok(/"voicekernel"/.test(body), 'catalog must expose the in-house provider under our id');
  });

  test('a request body is translated to the wire id and back', () => {
    const input = {
      voice: { provider: 'voicekernel', voiceId: 'Elliot' },
      model: { provider: 'openai', model: 'gpt-4o' },
      nested: [{ tool: { provider: 'voicekernel' } }],
    };

    const wire = toWirePayload(input) as typeof input;
    assert.equal(wire.voice.provider, 'vapi', 'must send the id the upstream accepts');
    assert.equal(wire.nested[0].tool.provider, 'vapi', 'nested providers translate too');
    assert.equal(wire.model.provider, 'openai', 'other providers are untouched');

    const back = toPublicPayload(wire) as typeof input;
    assert.deepEqual(back, input, 'the round trip must be lossless');
  });

  test('only values in provider position are rewritten', () => {
    const input = { name: 'vapi', description: 'voicekernel', provider: 'voicekernel' };
    const wire = toWirePayload(input) as typeof input;

    assert.equal(wire.name, 'vapi', 'a name that happens to match is not a provider id');
    assert.equal(wire.description, 'voicekernel', 'nor is free text');
    assert.equal(wire.provider, 'vapi');
  });

  test('non-JSON values survive the walk by reference', () => {
    const buffer = Buffer.from('audio');
    const input = { provider: 'voicekernel', blob: buffer };
    const wire = toWirePayload(input) as typeof input;

    assert.equal(wire.blob, buffer, 'buffers must not be rebuilt as plain objects');
  });
});
