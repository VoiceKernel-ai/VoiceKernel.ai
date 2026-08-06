import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  // Never let a secret reach the log sink, even by accident.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-vapi-secret"]',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'apiKey',
      '*.apiKey',
      'vapiApiKey',
      '*.vapiApiKey',
      'secret',
      '*.secret',
    ],
    censor: '[redacted]',
  },
  transport: config.isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
});

export type Logger = typeof logger;
