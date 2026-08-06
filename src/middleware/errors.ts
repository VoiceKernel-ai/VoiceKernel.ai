import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../errors';
import { logger } from '../logger';
import { config } from '../config';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      type: 'not_found_error',
      code: 'unknown_endpoint',
      message: `No route matches ${req.method} ${req.path}. See ${config.publicBaseUrl}/docs for the API reference.`,
      requestId: req.requestId,
    },
  });
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    const details = err.errors.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    }));
    res.status(422).json({
      error: {
        type: 'invalid_request_error',
        code: 'validation_failed',
        message: 'The request body or query failed validation.',
        details,
        requestId: req.requestId,
      },
    });
    return;
  }

  if (err instanceof ApiError) {
    // 5xx from us is a defect; 4xx is the caller's problem and only worth debug.
    const level = err.status >= 500 ? 'error' : 'debug';
    logger[level](
      { err, requestId: req.requestId, path: req.path, status: err.status },
      'request failed',
    );
    res.status(err.status).json({
      ...err.toJSON(),
      error: { ...err.toJSON().error, requestId: req.requestId },
    });
    return;
  }

  // Postgres surfaces a few conditions worth translating rather than 500ing.
  const pgCode = (err as { code?: string } | null)?.code;
  if (pgCode === '23505') {
    res.status(409).json({
      error: {
        type: 'conflict_error',
        code: 'already_exists',
        message: 'That resource already exists.',
        requestId: req.requestId,
      },
    });
    return;
  }
  if (pgCode === '22P02' || pgCode === '22003') {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_identifier',
        message: 'One of the supplied identifiers is malformed.',
        requestId: req.requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId: req.requestId, path: req.path }, 'unhandled error');

  res.status(500).json({
    error: {
      type: 'api_error',
      code: 'internal_error',
      message: 'An unexpected error occurred. If it persists, contact support with the request id.',
      requestId: req.requestId,
      // Stack traces are useful locally and a disclosure risk in production.
      ...(config.isDev && err instanceof Error ? { debug: err.stack } : {}),
    },
  });
};
