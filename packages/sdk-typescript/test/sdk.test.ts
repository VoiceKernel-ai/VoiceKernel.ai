/**
 * SDK tests.
 *
 * The transport, retry policy and webhook verification are tested against a
 * stub fetch rather than a live API: these are properties of the client itself,
 * and pinning them here means a change in retry behaviour fails loudly instead
 * of silently double-placing calls in production.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { VoiceKernel } from '../src/client';
import { VoiceKernelError, VoiceKernelConnectionError } from '../src/errors';
import { verifyWebhook } from '../src/webhooks';

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(responses: Array<{ status: number; body: unknown }>) {
  const calls: StubCall[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });

    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

function client(fetchImpl: typeof globalThis.fetch, overrides = {}) {
  return new VoiceKernel({
    apiKey: 'vk_test_abcdefghijkl',
    baseUrl: 'https://api.example.test',
    fetch: fetchImpl,
    ...overrides,
  });
}

describe('construction', () => {
  test('requires an API key', () => {
    assert.throws(() => new VoiceKernel({ apiKey: '' }), /requires an apiKey/);
  });

  test('defaults to the production base URL', () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { object: 'list', data: [] } }]);
    const vk = new VoiceKernel({ apiKey: 'vk_live_x', fetch: fetchImpl });
    return vk.agents.list().then(() => {
      assert.match(calls[0].url, /^https:\/\/api\.voicekernel\.ai\//);
    });
  });
});

describe('authentication', () => {
  test('sends the key as a bearer token', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { object: 'list', data: [] } }]);
    await client(fetchImpl).agents.list();
    assert.equal(calls[0].headers.authorization, 'Bearer vk_test_abcdefghijkl');
  });
});

describe('errors', () => {
  test('surfaces the API envelope as a typed error', async () => {
    const { fetchImpl } = stub([
      {
        status: 403,
        body: {
          error: {
            type: 'permission_error',
            code: 'permission_denied',
            message: 'This API key lacks the "agents:write" scope.',
            requestId: 'req_abc123',
          },
        },
      },
    ]);

    await assert.rejects(
      () => client(fetchImpl).agents.create({ name: 'x', systemPrompt: 'y' }),
      (err: unknown) => {
        assert.ok(err instanceof VoiceKernelError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'permission_denied');
        assert.equal(err.requestId, 'req_abc123');
        assert.equal(err.isAuthError, true);
        assert.equal(err.isRetryable, false);
        return true;
      },
    );
  });

  test('flags a budget error distinctly from other 4xx', async () => {
    const { fetchImpl } = stub([
      { status: 402, body: { error: { code: 'budget_exhausted', message: 'Budget reached.' } } },
    ]);
    await assert.rejects(
      () => client(fetchImpl).campaigns.create({ name: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof VoiceKernelError);
        assert.equal(err.isBudgetError, true);
        return true;
      },
    );
  });

  test('raises a connection error when the API is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => client(fetchImpl, { maxRetries: 0 }).agents.list(),
      (err: unknown) => {
        assert.ok(err instanceof VoiceKernelConnectionError);
        assert.match(err.message, /ECONNREFUSED/);
        return true;
      },
    );
  });
});

describe('retries', () => {
  test('retries a GET on 503 and returns the eventual success', async () => {
    const { fetchImpl, calls } = stub([
      { status: 503, body: { error: { message: 'upstream down' } } },
      { status: 200, body: { object: 'list', data: [{ id: 'asst_1' }] } },
    ]);

    const result = await client(fetchImpl).agents.list();
    assert.equal(calls.length, 2);
    assert.equal(result.data.length, 1);
  });

  test('does NOT retry a POST without an idempotency key', async () => {
    const { fetchImpl, calls } = stub([{ status: 503, body: { error: { message: 'down' } } }]);

    await assert.rejects(() => client(fetchImpl).agents.create({ name: 'x', systemPrompt: 'y' }));
    // Replaying an unkeyed create could produce two agents.
    assert.equal(calls.length, 1, 'an unkeyed POST must be attempted exactly once');
  });

  test('placing a call always carries an idempotency key', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { id: 'call_1' } }]);
    await client(fetchImpl).calls.create({ to: '+61400000000', agentId: 'asst_1' });

    assert.ok(
      calls[0].headers['idempotency-key'],
      'a retried timeout must never place a second call',
    );
  });

  test('a keyed POST is retried, since replay is safe', async () => {
    const { fetchImpl, calls } = stub([
      { status: 500, body: { error: { message: 'boom' } } },
      { status: 200, body: { id: 'call_1' } },
    ]);
    await client(fetchImpl).calls.create({ to: '+61400000000', agentId: 'asst_1' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
  });
});

describe('requests', () => {
  test('builds query strings from list params', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { object: 'list', data: [] } }]);
    await client(fetchImpl).calls.list({ limit: 25, status: 'ended' });
    assert.match(calls[0].url, /limit=25/);
    assert.match(calls[0].url, /status=ended/);
  });

  test('setModel targets the dedicated endpoint that preserves the prompt', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: { id: 'asst_1' } }]);
    await client(fetchImpl).agents.setModel('asst_1', { provider: 'anthropic', model: 'claude-sonnet-5' });

    assert.equal(calls[0].method, 'PUT');
    assert.match(calls[0].url, /\/v1\/agents\/asst_1\/model$/);
    assert.deepEqual(calls[0].body, { provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  test('escapes ids in paths', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
    await client(fetchImpl).subjects.preview('+61 400 000 000');
    assert.match(calls[0].url, /%2B61%20400%20000%20000/);
  });

  test('provider() reaches the passthrough surface', async () => {
    const { fetchImpl, calls } = stub([{ status: 200, body: {} }]);
    await client(fetchImpl).provider('GET', '/assistant/abc');
    assert.match(calls[0].url, /\/v1\/provider\/assistant\/abc$/);
  });
});

describe('pagination', () => {
  test('walks pages until one comes back short', async () => {
    let page = 0;
    const fetchImpl = (async () => {
      page++;
      const data = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: `call_${i}` }))
        : [{ id: 'call_last' }];
      return new Response(JSON.stringify({ object: 'list', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const seen: string[] = [];
    for await (const call of client(fetchImpl).calls.iterate()) {
      seen.push((call as { id: string }).id);
    }

    assert.equal(seen.length, 101);
    assert.equal(seen[100], 'call_last');
  });
});

describe('webhook verification', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'call.ended', created: 0, data: {} });

  function sign(payload: string, at: number, withSecret = secret): string {
    const mac = crypto.createHmac('sha256', withSecret).update(`${at}.${payload}`).digest('hex');
    return `t=${at},v1=${mac}`;
  }

  test('accepts a correctly signed delivery', () => {
    const now = Math.floor(Date.now() / 1000);
    const event = verifyWebhook(body, sign(body, now), secret);
    assert.equal(event.type, 'call.ended');
  });

  test('rejects a tampered body', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = sign(body, now);
    assert.throws(() => verifyWebhook(body + ' ', header, secret), /does not match/);
  });

  test('rejects the wrong secret', () => {
    const now = Math.floor(Date.now() / 1000);
    assert.throws(() => verifyWebhook(body, sign(body, now, 'whsec_other'), secret), /does not match/);
  });

  test('rejects a replayed delivery outside the tolerance window', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    assert.throws(() => verifyWebhook(body, sign(body, old), secret), /replay/);
  });

  test('rejects a missing or malformed header', () => {
    assert.throws(() => verifyWebhook(body, undefined, secret), /No X-VoiceKernel-Signature/);
    assert.throws(() => verifyWebhook(body, 'garbage', secret), /Could not parse/);
  });

  test('throws rather than returning false', () => {
    // A caller who forgets to check a boolean would silently accept forgeries.
    const now = Math.floor(Date.now() / 1000);
    const result = verifyWebhook(body, sign(body, now), secret);
    assert.equal(typeof result, 'object');
  });
});
