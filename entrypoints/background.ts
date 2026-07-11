/**
 * Background Service Worker — Shotly (architecture v1.2 §2.3, §3.1)
 *
 * Responsibilities:
 *   - Open / maintain `screenshot-port` long connections with 20s heartbeat
 *     (so MV3 SW is not killed mid-pipeline).
 *   - Dispatch `chrome.tabs.captureVisibleTab` from the SW context.
 *   - Manage a single offscreen document (Chrome allows only one at a time).
 *   - Handle keyboard shortcuts (Alt+Shift+S / Alt+Shift+V) via commands API.
 *
 * D+1 scope: port skeleton + heartbeat. Capture dispatch lands D+2.
 */

import {
  PORT_NAMES,
  PROTOCOL_VERSION,
  type Envelope,
  type Scope,
} from '../utils/messaging';

// Track active port + heartbeat timers (one entry per port)
const activePorts = new Map<
  chrome.runtime.Port,
  { heartbeat: ReturnType<typeof setInterval>; scope: Scope; name: string }
>();

// Track single offscreen document (Chrome hard constraint)
let offscreenReady: Promise<void> | null = null;

export default defineBackground(() => {
  console.info('[shotly:bg] service worker booted');

  // ─── Port connections (long-lived) ────────────────────────────────────────
  chrome.runtime.onConnect.addListener((port) => {
    if (
      port.name !== PORT_NAMES.screenshot &&
      port.name !== PORT_NAMES.history &&
      port.name !== PORT_NAMES.license
    ) {
      return; // unknown port — let other handlers deal with it
    }

    const scope: Scope =
      port.sender?.tab != null
        ? 'content'
        : port.name === PORT_NAMES.screenshot
          ? 'popup'
          : 'popup';

    // 20s heartbeat prevents SW idle kill (architecture §2.3.3)
    const heartbeat = setInterval(() => {
      try {
        port.postMessage({
          v: PROTOCOL_VERSION,
          id: '__heartbeat__',
          scope: 'bg',
          type: `${port.name.replace('-port', '')}:heartbeat`,
          payload: { ts: Date.now() },
        } satisfies Envelope);
      } catch {
        clearInterval(heartbeat);
        activePorts.delete(port);
      }
    }, 20_000);

    activePorts.set(port, { heartbeat, scope, name: port.name });

    port.onDisconnect.addListener(() => {
      clearInterval(heartbeat);
      activePorts.delete(port);
      console.info(`[shotly:bg] port ${port.name} disconnected`);
    });

    port.onMessage.addListener((envelope: Envelope) => {
      // Drop our own heartbeats
      if (envelope.id === '__heartbeat__') return;
      handlePortMessage(port, envelope).catch((err) => {
        console.error('[shotly:bg] handlePortMessage error:', err);
        try {
          port.postMessage({
            v: PROTOCOL_VERSION,
            id: envelope.id,
            scope: 'bg',
            type: `${envelope.type}:error`,
            payload: { message: (err as Error).message },
          } satisfies Envelope);
        } catch {
          /* port closed */
        }
      });
    });
  });

  // ─── Keyboard shortcuts (architecture §4.1 commands) ─────────────────────
  chrome.commands?.onCommand?.addListener((cmd) => {
    if (cmd === 'capture-full-page' || cmd === 'capture-visible') {
      chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          if (!tab?.id) return;
          // Forward to content script via the screenshot-port
          // D+2 will implement the actual capture kickoff
          console.info(
            `[shotly:bg] command ${cmd} → would dispatch to tab ${tab.id}`,
          );
        });
    }
  });

  // ─── Offscreen document lifecycle ─────────────────────────────────────────
  async function ensureOffscreen(): Promise<void> {
    if (offscreenReady) return offscreenReady;
    offscreenReady = (async () => {
      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
          justification:
            'Stitching screenshot chunks via OffscreenCanvas (architecture §3.1)',
        });
        console.info('[shotly:bg] offscreen document ready');
      } catch (err) {
        // 'Only a single offscreen document may exist' is OK if one already exists
        if (!(err as Error).message.includes('single offscreen')) throw err;
      }
    })();
    return offscreenReady;
  }
  void ensureOffscreen;
});

// ─── Message router ─────────────────────────────────────────────────────────

async function handlePortMessage(
  port: chrome.runtime.Port,
  env: Envelope,
): Promise<void> {
  switch (env.type) {
    case 'screenshot:ping':
      // Simple liveness check used by popup on mount
      port.postMessage({
        v: PROTOCOL_VERSION,
        id: env.id,
        scope: 'bg',
        type: 'screenshot:pong',
        payload: { ts: Date.now() },
      } satisfies Envelope);
      break;

    // D+2 will add:
    //   'screenshot:dispatch-capture'  → tab.captureVisibleTab
    //   'screenshot:stitch-chunk'      → offscreen canvas draw
    //   'screenshot:finalize'          → blob back to popup

    default:
      console.debug(`[shotly:bg] unhandled message type: ${env.type}`);
  }
}