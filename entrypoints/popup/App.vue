<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { theme, detectTheme, watchTheme, type ThemeMode } from '../../utils/theme';
import {
  CAPTURE_MSG,
  PORT_NAMES,
  PROTOCOL_VERSION,
  type Envelope,
  type FinalizeResponse,
  type StartFullResponse,
} from '../../utils/messaging';

const mode = ref<ThemeMode>('light');
const status = ref<'idle' | 'starting' | 'capturing' | 'finalizing' | 'done' | 'error'>('idle');
const progress = ref<{ i: number; total: number } | null>(null);
const errorMsg = ref<string | null>(null);
const result = ref<FinalizeResponse | null>(null);
let unwatch: (() => void) | null = null;
let port: chrome.runtime.Port | null = null;

// Heartbeat to keep the SW alive while the popup is open (architecture §2.3.3).
// 20s matches bg/content — same window, lower wake cost.
const HEARTBEAT_MS = 20_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  mode.value = detectTheme();
  unwatch = watchTheme((m) => (mode.value = m));
  openPopupPort();
  // Test hook: `?testUrlPattern=<url>` overrides the active-tab lookup so
  // Playwright can drive the popup as a regular tab (chrome-extension://...).
  // Capture is triggered manually via window.__shotlyTestCapture() to keep
  // tests deterministic and avoid double-fire from accidental re-mounts.
  const params = new URLSearchParams(location.search);
  const testUrlPattern = params.get('testUrlPattern');
  if (testUrlPattern) {
    chrome.tabs.query({ url: testUrlPattern }, (tabs) => {
      const first = tabs[0];
      if (first?.id) {
        (window as unknown as { __shotlyTestTabId?: number }).__shotlyTestTabId = first.id;
      } else {
        console.warn(`[shotly:test] no tab matched pattern ${testUrlPattern}`);
      }
    });
  }
  // Expose live state for assertions
  (window as unknown as {
    __shotlyTest?: {
      getStatus(): typeof status.value;
      getResult(): FinalizeResponse | null;
      getError(): string | null;
      getProgress(): { i: number; total: number } | null;
      capture(): void;
    };
  }).__shotlyTest = {
    getStatus: () => status.value,
    getResult: () => result.value,
    getError: () => errorMsg.value,
    getProgress: () => progress.value,
    capture: () =>
      captureFull().catch((err) => console.error('[shotly:test] capture failed:', err)),
  };
});

onUnmounted(() => {
  unwatch?.();
  stopHeartbeat();
  port?.disconnect();
  if (result.value?.blobUrl) {
    // Free the blob URL when the popup closes.
    URL.revokeObjectURL(result.value.blobUrl);
  }
});

const t = () => theme[mode.value];

function openPopupPort() {
  try {
    console.info('[shotly:popup] openPopupPort: calling chrome.runtime.connect');
    port = chrome.runtime.connect({ name: PORT_NAMES.screenshot });
    console.info('[shotly:popup] openPopupPort: got port, name=' + port.name);
    port.onDisconnect.addListener(() => {
      console.info('[shotly:popup] port disconnected');
      port = null;
      stopHeartbeat();
    });
    port.onMessage.addListener((env: Envelope) => {
      if (env.id === '__heartbeat__') return;
      switch (env.type) {
        case 'screenshot:progress':
          progress.value = env.payload as { i: number; total: number };
          status.value = 'capturing';
          break;
        case 'screenshot:done':
          result.value = env.payload as FinalizeResponse;
          status.value = 'done';
          break;
        case 'screenshot:error':
          errorMsg.value = (env.payload as { message: string }).message;
          status.value = 'error';
          break;
        case 'screenshot:too-long':
          errorMsg.value = `Page too long: ${(env.payload as { totalHeight: number }).totalHeight}px > 50_000px limit`;
          status.value = 'error';
          break;
      }
    });
    startHeartbeat();
    // Ping so we know the port is alive
    port.postMessage({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      scope: 'popup',
      type: 'screenshot:ping',
    } satisfies Envelope);
  } catch (err) {
    console.error('[shotly:popup] failed to open port:', err);
    errorMsg.value = (err as Error).message;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    try {
      port?.postMessage({
        v: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        scope: 'popup',
        type: 'screenshot:popup-heartbeat',
        payload: { ts: Date.now() },
      } satisfies Envelope);
    } catch {
      stopHeartbeat();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

async function captureFull() {
  console.info('[shotly:popup] captureFull called');
  if (!port) {
    errorMsg.value = 'not connected to background';
    return;
  }
  // Guard: Vue's onMounted occasionally fires twice in MV3 popup contexts
  // (e.g. after HMR-style re-evaluation). Without this guard, kickoffCapture
  // runs twice → two content ports → one of them collides / disconnects →
  // FINALIZE returns the wrong payload. (architecture §2.3 hotfix 2026-07-12)
  if (status.value === 'starting' || status.value === 'capturing' || status.value === 'finalizing') {
    console.info('[shotly:popup] captureFull already in progress, skipping duplicate');
    return;
  }
  status.value = 'starting';
  progress.value = null;
  result.value = null;
  errorMsg.value = null;

  // Find the active tab in the current window and ask bg to kick the pipeline.
  // Test override: window.__shotlyTestTabId bypasses the active-tab lookup so
  // Playwright can drive the popup as a regular tab (chrome-extension://.../popup.html).
  const overrideId = (window as unknown as { __shotlyTestTabId?: number }).__shotlyTestTabId;
  const resolveTabId = (cb: (id: number) => void) => {
    if (overrideId && overrideId > 0) {
      cb(overrideId);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab?.id) {
        errorMsg.value = 'no active tab';
        status.value = 'error';
        return;
      }
      cb(tab.id);
    });
  };

  resolveTabId((tabId: number) => {
    const reqId = crypto.randomUUID();
    const ackListener = (env: Envelope) => {
      if (env.id !== reqId) return;
      if (env.type === `${CAPTURE_MSG.START_FULL}:ack`) {
        const payload = env.payload as StartFullResponse;
        if (!payload.ok) {
          errorMsg.value = payload.reason ?? 'failed to start';
          status.value = 'error';
        } else {
          status.value = 'capturing';
        }
        port?.onMessage.removeListener(ackListener);
      }
    };
    port?.onMessage.addListener(ackListener);

    console.info(`[shotly:popup] posting START_FULL tabId=${tabId}`);
    port?.postMessage({
      v: PROTOCOL_VERSION,
      id: reqId,
      scope: 'popup',
      type: CAPTURE_MSG.START_FULL,
      payload: { tabId },
    } satisfies Envelope);
  });
}

function captureRegion() {
  // Region capture ships in v1.1 — D+2 keeps the button as a no-op
  // placeholder so the popup layout stays stable.
  console.info('[shotly:popup] region capture requested (v1.1)');
}

async function downloadResult() {
  if (!result.value) return;
  try {
    const res = await fetch(result.value.blobUrl);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = result.value.blobUrl;
    a.download = `shotly-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    void blob; // satisfy linter — we used the URL directly
  } catch (err) {
    errorMsg.value = `download failed: ${(err as Error).message}`;
  }
}
</script>

<template>
  <div
    :style="{
      background: t().bg,
      color: t().text,
      borderColor: t().border,
      boxShadow: t().shadow,
    }"
    class="popup"
  >
    <header class="header">
      <div class="brand">
        <span class="logo" :style="{ background: t().brand }">📸</span>
        <span class="name">Shotly</span>
      </div>
      <div class="actions">
        <button
          class="icon-btn"
          :style="{ color: t().textMuted }"
          title="Settings"
        >
          ⚙️
        </button>
        <button
          class="icon-btn"
          :style="{ color: t().textMuted }"
          title="Help"
        >
          ❓
        </button>
      </div>
    </header>

    <main class="grid">
      <button
        class="card card-primary"
        :style="{
          background: t().brand,
          color: t().brandFg,
        }"
        :disabled="status === 'starting' || status === 'capturing' || status === 'finalizing'"
        @click="captureFull"
      >
        <span class="card-icon">📷</span>
        <span class="card-label">整页截图</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
        :disabled="status === 'starting' || status === 'capturing' || status === 'finalizing'"
        @click="captureRegion"
      >
        <span class="card-icon">▭</span>
        <span class="card-label">区域截图</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
      >
        <span class="card-icon">⏱</span>
        <span class="card-label">历史库</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
      >
        <span class="card-icon">⌨</span>
        <span class="card-label">快捷键</span>
      </button>
    </main>

    <!-- Status / progress / result panel (D+2: real feedback) -->
    <section
      v-if="status !== 'idle'"
      class="status"
      :style="{
        background: t().surfaceAlt,
        color: t().text,
        borderColor: t().border,
      }"
    >
      <div v-if="status === 'starting'" class="status-line">准备截图…</div>
      <div v-else-if="status === 'capturing' && progress" class="status-line">
        截取中 {{ progress.i + 1 }} / {{ progress.total }}
        <div class="bar">
          <div
            class="bar-fill"
            :style="{
              width: `${Math.round(((progress.i + 1) / progress.total) * 100)}%`,
              background: t().brand,
            }"
          />
        </div>
      </div>
      <div v-else-if="status === 'finalizing'" class="status-line">合成中…</div>
      <div v-else-if="status === 'done' && result" class="status-line">
        ✅ 完成 · {{ Math.round(result.byteSize / 1024) }} KB ·
        {{ result.width }}×{{ result.height }}
        <button
          class="dl-btn"
          :style="{ background: t().brand, color: t().brandFg }"
          @click="downloadResult"
        >
          下载
        </button>
      </div>
      <div v-else-if="status === 'error'" class="status-line error">
        ❌ {{ errorMsg }}
      </div>
    </section>

    <footer
      class="footer"
      :style="{
        background: t().surfaceAlt,
        color: t().textMuted,
        borderColor: t().border,
      }"
    >
      ✨ 升级 Pro 解锁编辑器 + 水印
    </footer>
  </div>
</template>

<style scoped>
.popup {
  width: 320px;
  min-height: 360px;
  border-radius: 12px;
  border: 1px solid;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  overflow: hidden;
  transition: background 200ms ease, color 200ms ease;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 8px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 16px;
}
.name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.actions {
  display: flex;
  gap: 6px;
}
.icon-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 150ms ease;
}
.icon-btn:hover {
  background: rgba(0, 0, 0, 0.05);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px 16px;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 92px;
  border-radius: 12px;
  border: 1px solid;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: transform 100ms ease, filter 150ms ease;
}
.card:hover:not(:disabled) {
  filter: brightness(1.05);
}
.card:active:not(:disabled) {
  transform: scale(0.97);
}
.card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.card-primary {
  border: none;
}
.card-icon {
  font-size: 22px;
}
.card-label {
  font-size: 13px;
}

.status {
  margin: 0 16px 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid;
  font-size: 12px;
}
.status-line {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.status-line.error {
  color: #dc2626;
}
.bar {
  width: 100%;
  height: 4px;
  background: rgba(0, 0, 0, 0.08);
  border-radius: 2px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  transition: width 200ms ease;
}
.dl-btn {
  margin-top: 6px;
  align-self: flex-start;
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.footer {
  text-align: center;
  font-size: 12px;
  padding: 12px 16px;
  border-top: 1px solid;
  margin-top: 8px;
}
</style>