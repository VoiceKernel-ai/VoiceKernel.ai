import crypto from 'node:crypto';
import { VoiceKernelError } from './errors';
import type { WebhookEvent } from './types';

/**
 * Webhook signature verification.
 *
 * This is the security-critical half of the integration: without it, anyone who
 * learns a customer's endpoint URL can forge call events. The helper is
 * deliberately strict - it verifies the MAC in constant time *and* enforces a
 * timestamp window, because a valid signature replayed a week later is still an
 * attack.
 *
 * Verify against the RAW request body. Re-serialising a parsed object changes
 * key order and whitespace, and the signature will not match.
 */

export interface VerifyOptions {
  /** Max age of a delivery, in seconds. Default 300. */
  toleranceSeconds?: number;
}

function parseHeader(header: string): { timestamp: number; signature: string } | null {
  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index === -1) continue;
    parts[segment.slice(0, index).trim()] = segment.slice(index + 1).trim();
  }
  const timestamp = Number.parseInt(parts.t ?? '', 10);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return null;
  return { timestamp, signature };
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verifies a delivery and returns the parsed event.
 *
 * Throws rather than returning false: a caller who forgets to check a boolean
 * silently accepts forged events, whereas an unhandled throw fails loudly.
 *
 * @param payload   The raw request body, as a string or Buffer.
 * @param header    Value of the `X-VoiceKernel-Signature` header.
 * @param secret    The endpoint's signing secret (`whsec_…`).
 */
export function verifyWebhook<T = Record<string, unknown>>(
  payload: string | Buffer,
  header: string | undefined | null,
  secret: string,
  options: VerifyOptions = {},
): WebhookEvent<T> {
  if (!header) {
    throw new VoiceKernelError(400, { code: 'missing_signature' }, 'No X-VoiceKernel-Signature header present.');
  }
  if (!secret) {
    throw new VoiceKernelError(400, { code: 'missing_secret' }, 'No webhook signing secret supplied.');
  }

  const parsed = parseHeader(header);
  if (!parsed) {
    throw new VoiceKernelError(400, { code: 'malformed_signature' }, `Could not parse signature header: ${header}`);
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const age = Math.abs(Date.now() / 1000 - parsed.timestamp);
  if (age > tolerance) {
    throw new VoiceKernelError(
      400,
      { code: 'signature_expired' },
      `Delivery is ${Math.round(age)}s old, outside the ${tolerance}s tolerance. Rejecting as a possible replay.`,
    );
  }

  const body = typeof payload === 'string' ? payload : payload.toString('utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${body}`)
    .digest('hex');

  if (!safeEqual(expected, parsed.signature)) {
    throw new VoiceKernelError(
      401,
      { code: 'signature_mismatch' },
      'Webhook signature does not match. Verify you are using the raw request body and the correct endpoint secret.',
    );
  }

  return JSON.parse(body) as WebhookEvent<T>;
}

/**
 * Express-style middleware factory.
 *
 * Mount with a raw body parser, not `express.json()` - the signature is over
 * the exact bytes sent:
 *
 *   app.post('/hooks/voicekernel',
 *     express.raw({ type: 'application/json' }),
 *     voicekernelWebhook(process.env.VK_WEBHOOK_SECRET!, (event) => {
 *       if (event.type === 'call.ended') { ... }
 *     }));
 */
export function voicekernelWebhook<T = Record<string, unknown>>(
  secret: string,
  handler: (event: WebhookEvent<T>) => void | Promise<void>,
  options: VerifyOptions = {},
) {
  return async (
    req: { body: unknown; header?: (name: string) => string | undefined; headers?: Record<string, unknown> },
    res: { status: (code: number) => { send: (body?: string) => void; end: () => void } },
  ): Promise<void> => {
    const signature =
      req.header?.('x-voicekernel-signature') ??
      (req.headers?.['x-voicekernel-signature'] as string | undefined);

    let event: WebhookEvent<T>;
    try {
      event = verifyWebhook<T>(req.body as string | Buffer, signature, secret, options);
    } catch (err) {
      res.status(401).send(err instanceof Error ? err.message : 'invalid signature');
      return;
    }

    try {
      await handler(event);
      // 2xx marks the delivery successful; anything else is retried with
      // backoff, so acknowledge before doing slow work if you need to.
      res.status(200).end();
    } catch {
      // A 500 asks VoiceKernel to retry rather than dropping the event.
      res.status(500).end();
    }
  };
}
