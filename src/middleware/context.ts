import type { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'node:crypto';
import type { OrganizationRow } from '../services/org';
import type { ApiKeyRow } from '../services/apikeys';
import type { Role, UserRow } from '../services/auth';

/**
 * Per-request identity. Populated by the auth middleware and read by
 * everything downstream, so no route has to re-derive who is calling.
 */
export interface RequestActor {
  type: 'user' | 'api_key';
  id: string;
  label: string;
  scopes: string[];
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      org?: OrganizationRow;
      actor?: RequestActor;
      user?: UserRow;
      apiKey?: ApiKeyRow;
      rawBody?: Buffer;
    }
  }
}

export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Honour an upstream id so a trace survives the load balancer hop.
    const incoming = req.header('x-request-id');
    req.requestId = incoming && incoming.length <= 200 ? incoming : `req_${crypto.randomUUID()}`;
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}

/**
 * Wraps an async handler so a rejected promise reaches Express's error
 * pipeline. Express 4 does not await handlers, so without this an async throw
 * becomes an unhandled rejection and the client hangs until timeout.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function clientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
