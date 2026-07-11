/**
 * Offscreen document — Shotly (architecture v1.2 §1.4, §3.1)
 *
 * Lives in a hidden HTML document so we get a DOM/Canvas context outside
 * the Service Worker (which cannot use DOM in MV3). Chrome allows exactly
 * one offscreen document per extension — the background SW manages the
 * single instance.
 *
 * D+1 scope: boot + port handshake. Real chunk stitching lands D+2 once
 * the offscreen<->bg port contract is finalized.
 */

import { PORT_NAMES, PROTOCOL_VERSION, type Envelope } from '../utils/messaging';

export default defineUnlistedScript(() => {
  console.info('[shotly:offscreen] script booted');

  if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) {
    console.warn('[shotly:offscreen] chrome.runtime unavailable, skipping port setup');
    return;
  }

  try {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAMES.screenshot) return;

      port.onMessage.addListener(async (env: Envelope) => {
        if (env.id === '__heartbeat__') return;

        switch (env.type) {
          case 'offscreen:ping':
            port.postMessage({
              v: PROTOCOL_VERSION,
              id: env.id,
              scope: 'offscreen',
              type: 'offscreen:pong',
              payload: { hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined' },
            } satisfies Envelope);
            break;

          // D+2 will add:
          //   'screenshot:stitch-chunk'  → draw bitmap at offset
          //   'screenshot:finalize'      → convertToBlob → return

          default:
            console.debug(`[shotly:offscreen] unhandled: ${env.type}`);
        }
      });
    });
  } catch (err) {
    // wxt prepare uses a fake browser that throws on addListener
    console.warn('[shotly:offscreen] port setup skipped:', (err as Error).message);
  }
});