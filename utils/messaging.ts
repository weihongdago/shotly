/**
 * Shotly messaging layer (architecture v1.2 §2.3)
 *
 * Two transport modes:
 *   - `sendMessage` for instantaneous request/response (< 2s)
 *   - `connect` long-port for screenshot pipeline (30s~90s)
 *     because MV3 Service Worker is killed after 30s of inactivity.
 *
 * Heartbeat is set to 20s (less than Chrome's 30s SW idle threshold).
 */

export const PROTOCOL_VERSION = 1 as const;

export type Scope =
  | 'bg'
  | 'content'
  | 'popup'
  | 'offscreen'
  | 'options';

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  scope: Scope;
  type: string;
  payload?: T;
}

export const PORT_NAMES = {
  screenshot: 'screenshot-port',
  history: 'history-port',
  license: 'license-port',
} as const;

export type PortName = (typeof PORT_NAMES)[keyof typeof PORT_NAMES];

/**
 * Open a long-lived port to the background SW.
 * Heartbeat is 20s — keeps the SW alive during long screenshot pipelines.
 *
 * Caller MUST handle `onDisconnect` to clear its own timers.
 */
export function openPort(name: PortName): chrome.runtime.Port {
  const port = chrome.runtime.connect({ name });
  // Heartbeat to prevent SW idle kill (architecture §2.3.3)
  const heartbeat = setInterval(() => {
    try {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: cryptoRandomId(),
        scope: 'bg',
        type: 'screenshot:heartbeat',
      } satisfies Envelope);
    } catch {
      // Port is closed — cleanup will happen via onDisconnect
      clearInterval(heartbeat);
    }
  }, 20_000);
  port.onDisconnect.addListener(() => clearInterval(heartbeat));
  return port;
}

/**
 * Wrap a port with typed request/response matching via `id`.
 * Returns a Promise for the matching response envelope (same `id`).
 *
 * Times out after `timeoutMs` (default 90s) to prevent stuck promises.
 */
export function requestOverPort<TReq, TRes>(
  port: chrome.runtime.Port,
  type: string,
  payload: TReq,
  timeoutMs = 90_000,
): Promise<Envelope<TRes>> {
  return new Promise((resolve, reject) => {
    const id = cryptoRandomId();
    const timer = setTimeout(() => {
      port.onMessage.removeListener(listener);
      reject(new Error(`[shotly] port request '${type}' (id=${id}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(msg: unknown) {
      const env = msg as Envelope;
      if (env?.id !== id) return;
      clearTimeout(timer);
      port.onMessage.removeListener(listener);
      resolve(env as Envelope<TRes>);
    }

    port.onMessage.addListener(listener);
    port.postMessage({
      v: PROTOCOL_VERSION,
      id,
      scope: 'bg',
      type,
      payload,
    } satisfies Envelope<TReq>);
  });
}

/** Simple random id (no PII, no analytics). */
export function cryptoRandomId(): string {
  return crypto.randomUUID();
}

/** Sleep helper — used for retry/backoff in capture pipeline. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}