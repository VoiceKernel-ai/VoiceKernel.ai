import { config } from '../config';
import { logger } from '../logger';
import { attemptDelivery, claimDueDeliveries } from '../services/webhooks';
import { purgeExpiredIdempotencyKeys } from '../middleware/idempotency';

/**
 * Drains the outbound webhook queue.
 *
 * Runs in-process on a timer rather than as a separate service: a queue this
 * shape does not justify a broker, and co-locating keeps a single-container
 * deployment viable. Claiming uses FOR UPDATE SKIP LOCKED, so scaling to
 * several API instances works without further coordination.
 */

let running = false;
let timer: NodeJS.Timeout | null = null;
let housekeeping: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  // A slow endpoint must not cause overlapping passes to pile up.
  if (running) return;
  running = true;

  try {
    const batch = await claimDueDeliveries(20);
    if (batch.length === 0) return;

    logger.debug({ count: batch.length }, 'dispatching webhook deliveries');
    // Concurrent within a batch: one hung endpoint should not stall the others.
    await Promise.allSettled(batch.map((delivery) => attemptDelivery(delivery)));
  } catch (err) {
    logger.error({ err }, 'webhook dispatcher pass failed');
  } finally {
    running = false;
  }
}

export function startWebhookDispatcher(): void {
  if (timer) return;

  timer = setInterval(() => void tick(), config.webhooks.workerIntervalMs);
  timer.unref();

  housekeeping = setInterval(
    () => {
      void purgeExpiredIdempotencyKeys()
        .then((n) => {
          if (n > 0) logger.debug({ purged: n }, 'purged expired idempotency keys');
        })
        .catch((err) => logger.error({ err }, 'idempotency purge failed'));
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();

  logger.info(
    { intervalMs: config.webhooks.workerIntervalMs, maxAttempts: config.webhooks.maxAttempts },
    'webhook dispatcher started',
  );
}

export function stopWebhookDispatcher(): void {
  if (timer) clearInterval(timer);
  if (housekeeping) clearInterval(housekeeping);
  timer = null;
  housekeeping = null;
}
