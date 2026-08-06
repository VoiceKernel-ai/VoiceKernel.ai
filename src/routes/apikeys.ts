import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/context';
import { currentOrg, requireRole } from '../middleware/auth';
import {
  AVAILABLE_SCOPES,
  createApiKey,
  listApiKeys,
  publicApiKey,
  revokeApiKey,
} from '../services/apikeys';

/**
 * /v1/api-keys - credential management.
 *
 * Creating a key requires the admin role and is never permitted with an API
 * key as the credential: a leaked key must not be able to mint more keys or
 * silently widen its own scope.
 */
export const apiKeysRouter = Router();


apiKeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const keys = await listApiKeys(org.id);
    res.json({
      object: 'list',
      data: keys.map(publicApiKey),
      availableScopes: AVAILABLE_SCOPES,
    });
  }),
);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  environment: z.enum(['live', 'test']).default('live'),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.coerce.date().optional(),
});

apiKeysRouter.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);

    if (req.actor?.type === 'api_key') {
      res.status(403).json({
        error: {
          type: 'permission_error',
          code: 'session_required',
          message:
            'API keys cannot create other API keys. Sign in to the console to issue a new credential.',
        },
      });
      return;
    }

    const input = createSchema.parse(req.body ?? {});
    const { key, plaintext } = await createApiKey({
      orgId: org.id,
      name: input.name,
      environment: input.environment,
      scopes: input.scopes,
      createdBy: req.user?.id ?? null,
      expiresAt: input.expiresAt ?? null,
    });

    res.status(201).json({
      ...publicApiKey(key),
      // The only time the plaintext exists outside the client's hands.
      key: plaintext,
      warning: 'Store this key now - it cannot be retrieved again.',
    });
  }),
);

apiKeysRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    await revokeApiKey(org.id, req.params.id);
    res.json({ id: req.params.id, revoked: true });
  }),
);
