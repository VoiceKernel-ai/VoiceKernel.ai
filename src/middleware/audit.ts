import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { recordAudit } from '../services/audit';
import { clientIp } from './context';

/**
 * Records every state-changing request against the org that made it.
 *
 * Regulated buyers ask "who changed this agent's prompt, and when" during
 * sign-off, so the audit trail has to be automatic rather than something each
 * route remembers to call. Reads are skipped - logging them would bury the
 * changes that actually matter in noise.
 */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function auditRequests(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!MUTATING_METHODS.has(req.method)) return next();

    res.on('finish', () => {
      if (!req.org || !req.actor) return;

      void recordAudit({
        orgId: req.org.id,
        actorType: req.actor.type,
        actorId: req.actor.id,
        actorLabel: req.actor.label,
        action: `${req.method} ${req.route?.path ?? req.path}`,
        resourceKind: (req.params as Record<string, string>).kind ?? null,
        resourceId: (req.params as Record<string, string>).id ?? null,
        status: res.statusCode,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        metadata: {
          requestId: req.requestId,
          path: req.originalUrl,
          // The body can carry prompts and phone numbers; store only its shape.
          bodyKeys:
            req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 40) : [],
        },
      });
    });

    next();
  };
}
