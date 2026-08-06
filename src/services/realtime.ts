/**
 * Live event fan-out to connected consoles.
 *
 * Everything upstream already arrives as a webhook and is written to the
 * database within milliseconds, but the browser had no way to learn that, so
 * an operator watching a call in progress saw nothing until they navigated or
 * pressed Refresh. This closes that gap.
 *
 * Server-Sent Events rather than WebSockets: the traffic is one-way, it rides
 * the existing session cookie without a second auth path, it survives the
 * proxy in front of the origin as an ordinary HTTP response, and the browser
 * reconnects on its own. A WebSocket would buy bidirectionality the console
 * does not use, at the cost of an upgrade path through two proxies.
 *
 * SCOPE: subscribers are held in this process. That is correct while the API
 * runs as a single container, which it does. Running more than one would mean
 * a webhook landing on instance A never reaching a console attached to
 * instance B - at which point this should move to Postgres LISTEN/NOTIFY,
 * which every instance already has a connection for. Deliberately not done
 * ahead of need, but it is the reason `publish` takes only small,
 * serialisable values.
 */
import { logger } from '../logger';

export interface LiveEvent {
  id: string;
  type: string;
  resourceKind: string | null;
  resourceId: string | null;
  at: string;
}

type Subscriber = (event: LiveEvent) => void;

/** orgId -> the consoles currently watching it. */
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(orgId: string, fn: Subscriber): () => void {
  let set = subscribers.get(orgId);
  if (!set) {
    set = new Set();
    subscribers.set(orgId, set);
  }
  set.add(fn);

  return () => {
    const current = subscribers.get(orgId);
    if (!current) return;
    current.delete(fn);
    // Drop the bucket rather than leaving an empty Set per org that ever
    // connected; this map is otherwise unbounded over a long uptime.
    if (current.size === 0) subscribers.delete(orgId);
  };
}

/**
 * Notifies an org's consoles. Never throws: this runs inside the webhook path,
 * and a broken listener must not turn a delivered provider event into a 500
 * that gets retried.
 */
export function publish(orgId: string, event: LiveEvent): void {
  const set = subscribers.get(orgId);
  if (!set || set.size === 0) return;

  for (const fn of set) {
    try {
      fn(event);
    } catch (err) {
      logger.warn({ err, orgId }, 'a live event subscriber threw; dropping it');
      set.delete(fn);
    }
  }
}

/** Connected console count, for /health and for tests. */
export function subscriberCount(): number {
  let total = 0;
  for (const set of subscribers.values()) total += set.size;
  return total;
}
