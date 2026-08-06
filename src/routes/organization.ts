import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/context';
import { currentOrg, requireRole } from '../middleware/auth';
import {
  clearOrgProviderKey,
  listMembers,
  publicOrg,
  setOrgProviderKey,
  updateOrg,
} from '../services/org';
import { countByKind } from '../services/resources';

/**
 * /v1/organization - tenant settings, including which provider account backs it.
 */
export const organizationRouter = Router();


organizationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    res.json({ ...publicOrg(org), resources: await countByKind(org.id) });
  }),
);

organizationRouter.patch(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const patch = z
      .object({
        name: z.string().min(1).max(200).optional(),
        region: z.string().max(40).optional(),
        settings: z.record(z.unknown()).optional(),
      })
      .parse(req.body ?? {});
    res.json(publicOrg(await updateOrg(org.id, patch)));
  }),
);

organizationRouter.get(
  '/members',
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const members = await listMembers(org.id);
    res.json({
      object: 'list',
      data: members.map((m) => ({
        id: m.id,
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.created_at,
      })),
    });
  }),
);

/**
 * Bring-your-own provider key.
 *
 * Supplying a key moves the org off the shared platform account onto its own.
 * That changes the isolation model: on their own account every object is
 * theirs, so VoiceKernel stops filtering by the ownership registry and
 * account-wide endpoints (analytics, metrics) become available.
 */
organizationRouter.put(
  '/provider',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const { apiKey } = z.object({ apiKey: z.string().min(10) }).parse(req.body ?? {});
    const updated = await setOrgProviderKey(org.id, apiKey);
    res.json({
      ...publicOrg(updated),
      message:
        'provider key verified and stored. This organization now runs on its own provider account; full API passthrough is enabled.',
    });
  }),
);

organizationRouter.delete(
  '/provider',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const org = currentOrg(req);
    const updated = await clearOrgProviderKey(org.id);
    res.json({
      ...publicOrg(updated),
      message:
        'provider key removed. This organization is back on the shared VoiceKernel platform account. Objects created under your own key are no longer reachable.',
    });
  }),
);
