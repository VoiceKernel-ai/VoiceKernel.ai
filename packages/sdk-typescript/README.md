# @voicekernel/sdk

Official TypeScript client for the [VoiceKernel](https://voicekernel.ai) API.

Zero dependencies. Node 18+.

```bash
npm install @voicekernel/sdk
```

## Quick start

```ts
import { VoiceKernel } from '@voicekernel/sdk';

const vk = new VoiceKernel({ apiKey: process.env.VK_API_KEY! });

const agent = await vk.agents.create({
  name: 'Card disputes',
  systemPrompt:
    'You are a card disputes specialist for a retail bank. Answer only from the ' +
    'supplied policy documents. If unsure, escalate to a human.',
  firstMessage: "Thanks for calling - how can I help with your card today?",
  model: { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.3 },
  voice: { provider: '11labs', voiceId: 'matilda' },
  transcriber: { provider: 'deepgram', model: 'nova-3' },
});

await vk.calls.create({ to: '+61400000000', agentId: agent.id });
```

## Switching models

The prompt lives inside the upstream model object, so a naive patch clobbers it.
`setModel` does not:

```ts
await vk.agents.setModel(agent.id, { provider: 'openai', model: 'gpt-4o' });
```

`vk.catalog.list()` returns every provider and model the API accepts today - generated from the upstream spec, so it never drifts from what will validate.

## Placing calls safely

`calls.create` attaches an idempotency key automatically. A timeout that you
retry will **not** place a second call:

```ts
const call = await vk.calls.create({
  to: '+61400000000',
  agentId: agent.id,
  metadata: { ticket: 'INC-9912' },
});
```

Pass your own key when you want to dedupe across processes:

```ts
await vk.calls.create({ to, agentId }, { idempotencyKey: myJobId });
```

## Webhooks

Verify every delivery. Without it, anyone who learns your endpoint URL can forge
call events.

```ts
import express from 'express';
import { voicekernelWebhook } from '@voicekernel/sdk';

const app = express();

app.post(
  '/hooks/voicekernel',
  // Raw body - the signature is over the exact bytes sent.
  express.raw({ type: 'application/json' }),
  voicekernelWebhook(process.env.VK_WEBHOOK_SECRET!, async (event) => {
    if (event.type === 'call.ended') {
      await crm.recordCall(event.data);
    }
  }),
);
```

Or verify manually:

```ts
import { verifyWebhook } from '@voicekernel/sdk';

const event = verifyWebhook(rawBody, req.headers['x-voicekernel-signature'], secret);
```

`verifyWebhook` **throws** on a bad signature rather than returning `false` - a
caller who forgets to check a boolean silently accepts forgeries. It also
enforces a 300-second timestamp window, because a valid signature replayed a
week later is still an attack.

## Pagination

```ts
for await (const call of vk.calls.iterate({ status: 'ended' })) {
  console.log(call.id, call.durationSeconds);
}
```

## Errors

```ts
import { VoiceKernelError, VoiceKernelConnectionError } from '@voicekernel/sdk';

try {
  await vk.calls.create({ to, agentId });
} catch (err) {
  if (err instanceof VoiceKernelError) {
    // err.status, err.code, err.requestId - quote requestId to support.
    if (err.isBudgetError) {
      // 402: monthly budget reached. Outbound is paused; inbound is not.
    }
    if (err.isRetryable) { /* 429 or 5xx */ }
  } else if (err instanceof VoiceKernelConnectionError) {
    // Never reached the API at all.
  }
}
```

## Retry policy

`GET` and `DELETE` retry on transient failures with exponential backoff and
respect `Retry-After`. An unkeyed `POST` or `PATCH` is attempted **exactly
once** - replaying it could create a duplicate resource or place a second call.
Supply an `idempotencyKey` to make a write replay-safe.

## Everything else

Any upstream operation not wrapped by a typed method is reachable, with the same
auth, tenant isolation and audit:

```ts
const assistant = await vk.provider('GET', '/assistant/abc123');
const ops = await vk.provider('GET', '/_operations'); // what is reachable
```

## Compliance helpers

```ts
// What an erasure would touch, without touching it.
await vk.subjects.preview('+61400000000');

// Erase a caller. Check `complete` - a partial provider failure returns 207
// and must not be treated as a finished erasure.
const receipt = await vk.subjects.erase('+61400000000');
if (!receipt.complete) {
  console.error('Still pending upstream:', receipt.upstream.failures);
}
```

## Testing against a local server

```bash
VK_API_KEY=vk_live_… VK_BASE_URL=http://localhost:8080 \
  npx tsx packages/sdk-typescript/test/live.ts
```

## API reference

- `https://voicekernel.ai/docs` - surface, conventions, event vocabulary
- `https://voicekernel.ai/docs/openapi.json` - OpenAPI 3.1
- `https://voicekernel.ai/docs/operations` - the full upstream operation map
