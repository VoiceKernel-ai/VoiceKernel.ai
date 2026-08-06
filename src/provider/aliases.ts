/**
 * Public names for the upstream's in-house provider.
 *
 * The voice platform we run on ships its own LLM, voice and transcriber under
 * a provider id equal to its brand name. That id is a wire value: it appears
 * in request bodies customers send and in response bodies they read, so unlike
 * prose it cannot simply be reworded - rewording it would produce
 * documentation that gets rejected by the upstream.
 *
 * So it is translated instead. Customers say `voicekernel`; the wire says the
 * vendor's id. The mapping is applied at the proxy boundary in both
 * directions, which means the vendor name exists only between our process and
 * theirs, and never in anything a customer writes, reads or is billed against.
 *
 * Only values under a key named exactly `provider` are touched. A customer's
 * unrelated string that happens to equal one of these is left alone unless it
 * sits in that position, where the translation is what they asked for.
 */

/** Public id -> the id the upstream expects. */
const TO_WIRE: Record<string, string> = {
  voicekernel: 'vapi',
};

/** The id the upstream expects -> public id. */
const TO_PUBLIC: Record<string, string> = Object.fromEntries(
  Object.entries(TO_WIRE).map(([publicId, wireId]) => [wireId, publicId]),
);

/** The public provider id for the upstream's in-house models and voices. */
export const IN_HOUSE_PROVIDER = 'voicekernel';

export function toWireProvider(id: string): string {
  return TO_WIRE[id] ?? id;
}

export function toPublicProvider(id: string): string {
  return TO_PUBLIC[id] ?? id;
}

/**
 * Rewrite every `provider` value in a JSON-ish payload.
 *
 * Walks plain objects and arrays only. Anything else - Buffers, streams,
 * Dates, class instances - is returned by reference, because rebuilding those
 * would corrupt them and none of them carry a provider id.
 */
function mapProviders(value: unknown, translate: (id: string) => string, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapProviders(item, translate, seen));
  }

  if (!isPlainObject(value)) return value;

  // Upstream payloads are trees in practice, but a cycle here would hang the
  // request rather than fail it, which is the worse failure.
  if (seen.has(value)) return value;
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      key === 'provider' && typeof item === 'string'
        ? translate(item)
        : mapProviders(item, translate, seen);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Translate a customer's request body into what the upstream expects. */
export function toWirePayload<T>(payload: T): T {
  return mapProviders(payload, toWireProvider, new WeakSet()) as T;
}

/** Translate an upstream response into what the customer should see. */
export function toPublicPayload<T>(payload: T): T {
  return mapProviders(payload, toPublicProvider, new WeakSet()) as T;
}
