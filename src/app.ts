import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { config } from './config';
import { logger } from './logger';
import { healthcheck } from './db';
import { requestId } from './middleware/context';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { rateLimit } from './middleware/ratelimit';
import { partnersRouter } from './routes/partners';
import { authRouter } from './routes/auth';
import { v1Router } from './routes/v1';
import { inboundWebhooksRouter } from './routes/webhooks-in';
import { docsRouter } from './routes/docs';
import { PROVIDER_OPERATION_COUNT } from './provider/operations.generated';

/**
 * Locates the `web/` directory.
 *
 * Under tsx the module runs from src/, but the compiled build runs from
 * dist/src/ - so a single hard-coded `../web` is correct in development and
 * silently wrong in production, serving 404s for every page. Probing the
 * candidates keeps both layouts working without a copy step.
 */
function resolveWebRoot(): string {
  const candidates = [
    path.resolve(__dirname, '../web'),      // src/app.ts       -> ./web
    path.resolve(__dirname, '../../web'),   // dist/src/app.js  -> ./web
    path.resolve(process.cwd(), 'web'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  logger.warn({ candidates }, 'web/ not found - marketing pages and console will not be served');
  return candidates[0];
}

export function createApp(): express.Express {
  const app = express();

  // Behind a load balancer, req.ip must reflect X-Forwarded-For for rate
  // limiting and audit to record the real client.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(requestId());

  app.use(
    helmet({
      // The console and marketing pages are self-contained; the CSP below is
      // tight but allows the inline styles those pages ship with.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The WebRTC client is self-hosted, but at join time it fetches its own
          // versioned "call machine" bundle from the vendor's CDN. That is not
          // configurable away without pinning a 1.8 MB copy that must match the
          // SDK version exactly, so the origin is allowed instead.
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://c.dailywebrtc.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'https:'],
          // WebRTC for in-browser test calls. The room is served by the
          // upstream's media vendor, so the browser needs to reach it directly
          // and to allocate blob-backed workers and media streams for the
          // audio pipeline. Audio never transits VoiceKernel.
          connectSrc: [
            "'self'",
            'https://*.daily.co',
            'wss://*.daily.co',
            'https://c.dailywebrtc.net',
            'https://*.dailywebrtc.net',
            'wss://*.dailywebrtc.net',
          ],
          mediaSrc: ["'self'", 'blob:'],
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests carry no Origin header.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return callback(null, true);
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS policy.`));
      },
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    }),
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: {
        // Health checks and static assets would otherwise dominate the log.
        ignore: (req) =>
          req.url === '/health' || req.url === '/healthz' || Boolean(req.url?.startsWith('/assets')),
      },
    }),
  );

  app.use(cookieParser());

  // Multipart bodies are parsed per-route by multer; JSON everywhere else.
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        // Retained so webhook signature verification can hash the exact bytes
        // rather than a re-serialised object.
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ---- health ------------------------------------------------------------

  app.get('/health', async (_req, res) => {
    const dbOk = await healthcheck();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      service: 'voicekernel',
      version: '1.0.0',
      checks: { database: dbOk ? 'ok' : 'unreachable' },
      provider: {
        // Which vendor backs the platform is an implementation detail, not a
        // health signal. Whether a key is configured is the part an operator
        // needs; the hostname stays in config and logs.
        configured: Boolean(config.provider.apiKey),
        operationsCovered: PROVIDER_OPERATION_COUNT,
      },
      timestamp: new Date().toISOString(),
    });
  });
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // ---- inbound provider webhooks ----------------------------------------
  // Registered before the rate limiter: the voice provider's traffic is trusted-by-secret and
  // throttling it would drop call events.
  app.use('/webhooks', inboundWebhooksRouter);

  // ---- API ---------------------------------------------------------------

  app.use('/auth', authRouter);

  // Public: an integration partner applying has no account yet. Rate limited
  // by IP inside the router rather than sharing the API's credential-keyed
  // bucket, which would be meaningless for anonymous callers.
  app.use('/partners', partnersRouter);

  // A coarse per-IP limit in front of authentication, so a flood of invalid
  // keys cannot force an unbounded number of credential lookups. The per-tenant
  // limit lives inside v1Router, where the credential is actually known.
  app.use('/v1', rateLimit({ bucket: 'ip', max: config.rateLimit.max * 2 }), v1Router);

  // ---- docs + console + marketing ---------------------------------------

  app.use('/docs', docsRouter);

  const webRoot = resolveWebRoot();
  app.use(
    express.static(webRoot, {
      extensions: ['html'],
      maxAge: config.isProd ? '1h' : 0,
      index: 'index.html',
    }),
  );

  // The console is a single-page app: unknown /app/* paths render the shell so
  // a deep link or refresh does not 404.
  app.get(/^\/app(\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(webRoot, 'app', 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
