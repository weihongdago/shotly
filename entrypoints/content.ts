/**
 * Content script — Shotly (architecture v1.2 §2.3, §3)
 *
 * Runs in the page's isolated world. Responsibilities:
 *   - Accept `screenshot-port` connections from the background SW
 *   - Drive the scroll-and-stitch pipeline (plan → scroll → wait → emit chunk)
 *   - Install/restore iframe placeholders and hide fixed elements
 *
 * D+1 scope: port handshake + ping/pong + plan computation. Capture loop
 * wires to bg port in D+2 once `captureVisibleTab` round-trip is verified.
 */

import {
  PORT_NAMES,
  PROTOCOL_VERSION,
  type Envelope,
} from '../utils/messaging';
import {
  isPageTooLong,
  planCapture,
  runScrollAndCapture,
} from '../utils/screenshot-engine';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.info('[shotly:content] script injected');

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAMES.screenshot) return;

      const heartbeat = setInterval(() => {
        try {
          port.postMessage({
            v: PROTOCOL_VERSION,
            id: '__heartbeat__',
            scope: 'content',
            type: 'screenshot:content-heartbeat',
            payload: { ts: Date.now() },
          } satisfies Envelope);
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000); // slightly offset from bg's 20s to avoid sync

      port.onDisconnect.addListener(() => {
        clearInterval(heartbeat);
        console.info('[shotly:content] port disconnected');
      });

      port.onMessage.addListener(async (env: Envelope) => {
        if (env.id === '__heartbeat__') return;

        try {
          switch (env.type) {
            case 'screenshot:plan':
              // Reply with capture plan — bg uses this to size the offscreen canvas
              const plan = planCapture();
              port.postMessage({
                v: PROTOCOL_VERSION,
                id: env.id,
                scope: 'content',
                type: 'screenshot:plan-result',
                payload: {
                  plan,
                  tooLong: isPageTooLong(plan),
                },
              } satisfies Envelope);
              break;

            case 'screenshot:start':
              await handleStartCapture(port, env);
              break;

            case 'screenshot:abort':
              port.disconnect();
              break;

            default:
              console.debug(`[shotly:content] unhandled type: ${env.type}`);
          }
        } catch (err) {
          port.postMessage({
            v: PROTOCOL_VERSION,
            id: env.id,
            scope: 'content',
            type: 'screenshot:error',
            payload: { message: (err as Error).message },
          } satisfies Envelope);
        }
      });
    });
  },
});

async function handleStartCapture(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  const plan = planCapture();
  if (isPageTooLong(plan)) {
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: env.id,
      scope: 'content',
      type: 'screenshot:too-long',
      payload: {
        totalHeight: plan.totalHeight,
        limit: 50_000,
      },
    } satisfies Envelope);
    return;
  }

  await runScrollAndCapture({
    plan,
    onChunk: (chunk) => {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'content',
        type: 'screenshot:chunk',
        payload: chunk,
      } satisfies Envelope);
    },
    onProgress: (i, total) => {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'content',
        type: 'screenshot:progress',
        payload: { i, total },
      } satisfies Envelope);
    },
    onError: (err) => {
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'content',
        type: 'screenshot:error',
        payload: { message: err.message },
      } satisfies Envelope);
    },
  });

  port.postMessage({
    v: PROTOCOL_VERSION,
    id: env.id,
    scope: 'content',
    type: 'screenshot:done',
    payload: { segmentCount: plan.segments.length },
  } satisfies Envelope);
}