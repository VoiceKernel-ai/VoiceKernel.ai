/**
 * Live integration check for the SDK.
 *
 * Unlike the stubbed unit tests, this drives a running VoiceKernel API, so it
 * proves the client's assumptions about real response shapes rather than about
 * fixtures that could drift from the server.
 *
 *   VK_API_KEY=vk_live_… VK_BASE_URL=http://localhost:8080 \
 *     npx tsx packages/sdk-typescript/test/live.ts
 */
import crypto from 'node:crypto';
import { VoiceKernel, VoiceKernelError } from '../src/index';
import { verifyWebhook } from '../src/webhooks';

async function main(): Promise<void> {
  const apiKey = process.env.VK_API_KEY;
  if (!apiKey) {
    console.error('Set VK_API_KEY to run the live check.');
    process.exit(1);
  }

  const vk = new VoiceKernel({
    apiKey,
    baseUrl: process.env.VK_BASE_URL ?? 'http://localhost:8080',
  });

  const catalog = await vk.catalog.list();
  console.log(
    'catalog         ',
    catalog.counts.modelProviders,
    'model providers,',
    catalog.counts.models,
    'models',
  );

  const agents = await vk.agents.list();
  console.log('agents.list     ', agents.object, '| count', agents.data.length);

  const overview = await vk.analytics.overview();
  console.log('analytics       ', overview.calls.total, 'calls,', overview.minutes.total, 'min');

  const latency = await vk.analytics.latency();
  console.log(
    'latency         ',
    'samples',
    latency.sampleSize,
    '| turnP50',
    latency.turnP50,
    '|',
    latency.stages
      .filter((s) => s.p50 !== null)
      .map((s) => `${s.label} ${s.p50}`)
      .join(', '),
  );

  const billing = await vk.billing.get();
  console.log(
    'billing         ',
    'budget',
    billing.status.budget,
    '| outboundPaused',
    billing.status.outboundPaused,
  );

  const estimate = await vk.billing.estimate(600);
  console.log('estimate        ', estimate.minutes, 'min @', estimate.ratePerMinute);

  // Create an endpoint, then verify a delivery signed with its secret exactly
  // as an integrator would - this is the path that must never silently pass.
  const hook = await vk.webhookEndpoints.create({
    url: 'https://example.com/sdk-live',
    events: ['call.ended'],
  });
  console.log('webhook created ', hook.id, '| secret', `${hook.secret.slice(0, 12)}…`);

  const body = JSON.stringify({
    id: 'evt_x',
    object: 'event',
    type: 'call.ended',
    created: 0,
    data: {},
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', hook.secret).update(`${timestamp}.${body}`).digest('hex');
  const event = verifyWebhook(body, `t=${timestamp},v1=${mac}`, hook.secret);
  console.log('webhook verify  ', 'ok →', event.type);

  // A tampered body must be rejected, not merely reported.
  try {
    verifyWebhook(`${body} `, `t=${timestamp},v1=${mac}`, hook.secret);
    throw new Error('tampered payload was accepted - verification is broken');
  } catch (err) {
    if (!(err instanceof VoiceKernelError)) throw err;
    console.log('webhook tamper  ', 'rejected →', err.code);
  }

  await vk.webhookEndpoints.delete(hook.id);

  const ops = await vk.provider<{ totalOperations: number; availableOperations: number }>(
    'GET',
    '/_operations',
  );
  console.log('passthrough     ', ops.availableOperations, 'of', ops.totalOperations, 'operations');

  try {
    await vk.agents.create({
      name: 'X',
      systemPrompt: 'y',
      model: { provider: 'anthropic', model: 'gpt-4o' },
    });
    throw new Error('an invalid provider/model pair was accepted');
  } catch (err) {
    if (!(err instanceof VoiceKernelError)) throw err;
    console.log('typed error     ', err.status, err.code, '| requestId', err.requestId);
  }

  console.log('\nAll live checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
