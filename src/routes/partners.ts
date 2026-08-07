import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/context';
import { rateLimit } from '../middleware/ratelimit';
import { query, queryOne } from '../db';
import { logger } from '../logger';
import { ApiError } from '../errors';

export const partnersRouter = Router();

/**
 * Integration partner applications.
 *
 * Mounted outside /v1 because that router authenticates at its root, and an
 * applicant has no account yet - requiring one would invert the funnel this
 * exists to open.
 *
 * Being public, it is rate limited by IP and carries a honeypot. Neither stops
 * a determined submitter, but together they stop the drive-by form spam that
 * otherwise makes the review queue useless within a week.
 */
const applicationSchema = z
  .object({
    company: z.string().trim().min(1, 'Company name is required').max(200),
    website: z.string().trim().max(300).optional(),
    contactName: z.string().trim().min(1, 'A contact name is required').max(200),
    contactEmail: z.string().trim().email('A valid email address is required').max(320),
    country: z.string().trim().max(100).optional(),
    focus: z.string().trim().max(300).optional(),
    message: z.string().trim().max(4000).optional(),
    /**
     * Honeypot. Named to look worth filling in to a bot and hidden from people,
     * so anything arriving here was not typed by a human.
     *
     * Accepted by the schema rather than rejected: a validation error would
     * name the field and tell whoever wrote the bot exactly which one to leave
     * alone next time. It is checked in the handler instead, which answers as
     * though the submission succeeded.
     */
    fax: z.string().max(500).optional(),
  })
  .strict();

partnersRouter.post(
  '/apply',
  rateLimit({ bucket: 'partners', max: 5, windowMs: 60 * 60 * 1000, keyFn: (req) => req.ip ?? 'unknown' }),
  asyncHandler(async (req, res) => {
    const input = applicationSchema.parse(req.body ?? {});

    if (input.fax) {
      // Answer as though it worked. Telling a bot it was detected just teaches
      // whoever wrote it to fix the tell.
      logger.debug({ ip: req.ip }, 'partner application rejected by honeypot');
      res.status(202).json({ object: 'partner.application', received: true });
      return;
    }

    const row = await queryOne<{ id: string; created_at: Date }>(
      `INSERT INTO partner_applications
         (company, website, contact_name, contact_email, country, focus, message, source_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (lower(contact_email)) DO UPDATE SET
         company       = EXCLUDED.company,
         website       = EXCLUDED.website,
         contact_name  = EXCLUDED.contact_name,
         country       = EXCLUDED.country,
         focus         = EXCLUDED.focus,
         message       = EXCLUDED.message,
         updated_at    = now()
       RETURNING id, created_at`,
      [
        input.company,
        input.website ?? null,
        input.contactName,
        input.contactEmail,
        input.country ?? null,
        input.focus ?? null,
        input.message ?? null,
        req.ip ?? null,
        req.header('user-agent') ?? null,
      ],
    );

    if (!row) throw ApiError.internal('Could not record the application.');

    logger.info({ applicationId: row.id, company: input.company }, 'partner application received');

    // No application id in the response. It is not addressable by the
    // applicant, and returning one implies a status endpoint that does not
    // exist.
    res.status(201).json({
      object: 'partner.application',
      received: true,
      message: 'Thanks - we have your application and will be in touch.',
    });
  }),
);

/**
 * Programme summary, so the page can state real numbers rather than a
 * hard-coded "join 200+ partners" that nobody maintains.
 */
partnersRouter.get(
  '/summary',
  rateLimit({ bucket: 'partners-read', max: 60 }),
  asyncHandler(async (_req, res) => {
    const row = await queryOne<{ accepted: string }>(
      `SELECT count(*)::text AS accepted FROM partner_applications WHERE status = 'accepted'`,
    );
    res.json({
      object: 'partner.summary',
      acceptedPartners: Number(row?.accepted ?? 0),
    });
  }),
);

/** Ensures the table exists before the route is used, in deployments that have not migrated. */
export async function partnerApplicationsReady(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM partner_applications LIMIT 1');
    return true;
  } catch {
    return false;
  }
}
