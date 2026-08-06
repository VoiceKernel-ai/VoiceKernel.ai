import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { closePool, healthcheck } from './db';
import { startWebhookDispatcher, stopWebhookDispatcher } from './workers/webhook-dispatcher';
import { PROVIDER_OPERATION_COUNT } from './provider/operations.generated';

async function main(): Promise<void> {
  // Fail fast on a bad database URL rather than 500ing on the first request.
  if (!(await healthcheck())) {
    logger.error(
      { databaseUrl: config.databaseUrl.replace(/:[^:@]*@/, ':***@') },
      'cannot reach the database - run `npm run db:up && npm run migrate`',
    );
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        env: config.nodeEnv,
        publicBaseUrl: config.publicBaseUrl,
        providerOperations: PROVIDER_OPERATION_COUNT,
        platformProviderKey: Boolean(config.provider.apiKey),
      },
      'VoiceKernel API listening',
    );
  });

  startWebhookDispatcher();

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then release the pool. Without this a rolling deploy drops calls
  // mid-flight.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    stopWebhookDispatcher();
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });

    setTimeout(() => {
      logger.warn('forced exit after shutdown timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception - exiting');
    shutdown('uncaughtException');
  });
}

void main();
