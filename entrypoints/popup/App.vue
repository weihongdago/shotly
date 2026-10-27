<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { theme, detectTheme, watchTheme, type ThemeMode } from '../../utils/theme';
import {
  CAPTURE_MSG,
  EXPORT_MSG,
  PORT_NAMES,
  PROTOCOL_VERSION,
  REGION_MSG,
  type Envelope,
  type ExportConvertRequest,
  type ExportConvertResponse,
  type FinalizeResponse,
  type RegionAckResponse,
  type StartFullResponse,
} from '../../utils/messaging';
import { buildExportFilename, EXPORT_MIME, type ExportFormat } from '../../utils/export';
import {
  addHistory,
  deleteHistory,
  listHistory,
  type HistoryEntrySummary,
} from '../../utils/history-store';
import { useI18n } from '../../utils/i18n';

const mode = ref<ThemeMode>('light');
const status = ref<'idle' | 'starting' | 'selecting' | 'capturing' | 'finalizing' | 'done' | 'error'>('idle');
const progress = ref<{ i: number; total: number } | null>(null);
const errorMsg = ref<string | null>(null);
const result = ref<FinalizeResponse | null>(null);
let unwatch: (() => void) | null = null;
let port: chrome.runtime.Port | null = null;

// ─── Export / history state (D+3) ──────────────────────────────────────────
const format = ref<ExportFormat>('png');
const exporting = ref(false);
const copied = ref(false);
const saving = ref(false);
const showHistory = ref(false);
const historyItems = ref<HistoryEntrySummary[]>([]);
/** Blob URL minted by the offscreen converter — kept so we can download it. */
let exportBlobUrl: string | null = null;
/** Title of the page we captured, used for the export filename. */
let capturedTitle = 'screenshot';
/** Source URL of the captured page (stored locally, never uploaded). */
let capturedUrl = '';

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
  if (exportBlobUrl) {
    URL.revokeObjectURL(exportBlobUrl);
    exportBlobUrl = null;
  }
});

const t = () => theme[mode.value];

// ─── i18n (v1.0: en / zh) ────────────────────────────────────────────────────
// The store listing is English; the UI follows the browser language and
// can be switched by the user. `t()` is the theme accessor, so the
// translator is `i18n.t(...)`.
const i18n = useI18n();

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
        case 'screenshot:too-long': {
          // The content script sends the *effective* limit — it depends on
          // the device pixel ratio, because the stitch canvas is sized in
          // device pixels and Chrome refuses canvases taller than 65_535px.
          const p = env.payload as {
            totalHeight: number;
            limit: number;
            devicePixelRatio?: number;
            reason?: string;
          };
          // Compose the message here, in the user's language — the content
 // script cannot know the locale. The English `reason` it sends along
          // is the fallback for anyone reading the raw payload.
          const reason =
            p.devicePixelRatio && p.devicePixelRatio > 1
              ? i18n.t('error.pageTooLongReasonDpr', {
                  height: p.totalHeight,
                  dpr: p.devicePixelRatio,
                  max: 65_535,
                  limit: p.limit,
                })
              : i18n.t('error.pageTooLongReason', {
                  height: p.totalHeight,
                  limit: p.limit,
                });
          errorMsg.value = `${i18n.t('error.pageTooLong')}: ${reason}`;
          status.value = 'error';
          break;
        }
        // Region flow (architecture §3.2): the user finished dragging the
        // rectangle → the capture starts.
        case REGION_MSG.SELECTED:
          status.value = 'capturing';
          break;
        // The user pressed Escape → silently back to idle, no error toast.
        case REGION_MSG.CANCELLED:
          status.value = 'idle';
          progress.value = null;
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
  const tabId = await resolveActiveTabId();
  if (tabId == null) {
    errorMsg.value = 'no active tab';
    status.value = 'error';
    return;
  }

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
}

/**
 * Resolve the tab to capture.
 *
 * Test override: window.__shotlyTestTabId bypasses the active-tab lookup so
 * Playwright can drive the popup as a regular tab (chrome-extension://.../popup.html).
 */
function resolveActiveTabId(): Promise<number | null> {
  const overrideId = (window as unknown as { __shotlyTestTabId?: number }).__shotlyTestTabId;
  if (overrideId && overrideId > 0) {
    return Promise.resolve(overrideId);
  }
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        resolve(null);
        return;
      }
      // Remember page identity for the export filename + history metadata.
      // Stays local (IndexedDB) — never uploaded (privacy red line).
      capturedTitle = tab.title?.trim() || 'screenshot';
      capturedUrl = tab.url ?? '';
      resolve(tab.id);
    });
  });
}

/**
 * Region capture (architecture §3.2, decision B1).
 *
 * The user drags a rectangle on the page — that click closes the popup, so
 * the background saves the capture to the download folder when the popup is
 * gone. When the popup happens to stay open (e.g. the automated tests drive
 * it as a regular tab) the result shows up here like a normal capture.
 */
async function captureRegion() {
  console.info('[shotly:popup] captureRegion called');
  if (!port) {
    errorMsg.value = 'not connected to background';
    return;
  }
  if (
    status.value === 'starting' ||
    status.value === 'selecting' ||
    status.value === 'capturing' ||
    status.value === 'finalizing'
  ) {
    console.info('[shotly:popup] captureRegion already in progress, skipping duplicate');
    return;
  }
  status.value = 'selecting';
  progress.value = null;
  result.value = null;
  errorMsg.value = null;

  const tabId = await resolveActiveTabId();
  if (tabId == null) {
    errorMsg.value = 'no active tab';
    status.value = 'error';
    return;
  }

  const reqId = crypto.randomUUID();
  const ackListener = (env: Envelope) => {
    if (env.id !== reqId) return;
    if (env.type === `${REGION_MSG.START}:ack`) {
      const payload = env.payload as RegionAckResponse;
      if (!payload.ok) {
        errorMsg.value = payload.reason ?? 'failed to start region capture';
        status.value = 'error';
      }
      port?.onMessage.removeListener(ackListener);
    }
  };
  port?.onMessage.addListener(ackListener);

  console.info(`[shotly:popup] posting REGION_START tabId=${tabId}`);
  port?.postMessage({
    v: PROTOCOL_VERSION,
    id: reqId,
    scope: 'popup',
    type: REGION_MSG.START,
    payload: { tabId },
  } satisfies Envelope);
}

// ─── Export (D+3) ────────────────────────────────────────────────────────────

/**
 * Ask the background to convert the captured PNG into the selected format.
 *
 * Conversion happens in the offscreen document (it owns the canvas and
 * pdf-lib); the popup only ever holds a blob URL. We cache the converted
 * URL so re-downloading with the same format doesn't redo the work.
 */
async function convertExport(target: ExportFormat): Promise<string | null> {
  if (!result.value || !port) return null;
  if (exportBlobUrl && format.value === target) return exportBlobUrl;

  exporting.value = true;
  errorMsg.value = null;
  try {
    const reqId = crypto.randomUUID();
    const payload: ExportConvertRequest = {
      sourceBlobUrl: result.value.blobUrl,
      format: target,
    };
    const reply = await new Promise<ExportConvertResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`export '${target}' timed out after 30s`)),
        30_000,
      );
      const listener = (env: Envelope) => {
        if (env.id !== reqId) return;
        clearTimeout(timer);
        port?.onMessage.removeListener(listener);
        if (env.type === `${EXPORT_MSG.CONVERT}:error`) {
          reject(new Error((env.payload as { message: string }).message));
        } else if (env.type === `${EXPORT_MSG.CONVERT}:result`) {
          resolve(env.payload as ExportConvertResponse);
        } else {
          reject(new Error(`unexpected export reply: ${env.type}`));
        }
      };
      port?.onMessage.addListener(listener);
      port?.postMessage({
        v: PROTOCOL_VERSION,
        id: reqId,
        scope: 'popup',
        type: EXPORT_MSG.CONVERT,
        payload,
      } satisfies Envelope);
    });

    if (exportBlobUrl) URL.revokeObjectURL(exportBlobUrl);
    exportBlobUrl = reply.blobUrl;
    format.value = target;
    return exportBlobUrl;
  } catch (err) {
    errorMsg.value = `${i18n.t('error.exportFailed')}: ${(err as Error).message}`;
    return null;
  } finally {
    exporting.value = false;
  }
}

async function downloadResult() {
  if (!result.value) return;
  const url = await convertExport(format.value);
  if (!url) return;
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = buildExportFilename({
      title: capturedTitle,
      format: format.value,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    errorMsg.value = `download failed: ${(err as Error).message}`;
  }
}

/** Copy the capture to the system clipboard as an image. */
async function copyToClipboard() {
  if (!result.value) return;
  const url = await convertExport(format.value);
  if (!url) return;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    // ClipboardItem only accepts PNG for image/png — if the user picked
    // JPG/PDF we still paste the original PNG so pasting into Slack/WeChat
    // works (those apps expect a raster image, not a PDF).
    const pngBlob = blob.type === 'image/png' ? blob : result.value ? await pngFromCapture() : null;
    if (!pngBlob) throw new Error('no PNG payload available for clipboard');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch (err) {
    errorMsg.value = `copy failed: ${(err as Error).message}`;
  }
}

/** Fetch the original (PNG) capture blob — the clipboard needs a raster PNG. */
async function pngFromCapture(): Promise<Blob | null> {
  if (!result.value) return null;
  try {
    const res = await fetch(result.value.blobUrl);
    return await res.blob();
  } catch {
    return null;
  }
}

// ─── History (D+3) ───────────────────────────────────────────────────────────

async function saveToHistory() {
  if (!result.value) return;
  saving.value = true;
  errorMsg.value = null;
  try {
    const blob = await pngFromCapture();
    if (!blob) throw new Error('no capture blob to save');
    await addHistory({
      blob,
      meta: {
        url: capturedUrl,
        title: capturedTitle,
        capturedAt: Date.now(),
        width: result.value.width,
        height: result.value.height,
        format: 'png',
        size: blob.size,
        source: 'full',
      },
    });
    await loadHistory();
    status.value = 'done';
  } catch (err) {
    errorMsg.value = `${i18n.t('error.saveHistoryFailed')}: ${(err as Error).message}`;
  } finally {
    saving.value = false;
  }
}

async function loadHistory() {
  try {
    historyItems.value = await listHistory();
  } catch (err) {
    console.warn('[shotly:popup] loadHistory failed:', err);
    historyItems.value = [];
  }
}

async function toggleHistory() {
  showHistory.value = !showHistory.value;
  if (showHistory.value) await loadHistory();
}

/** Switching format invalidates the cached conversion. */
async function onFormatChange(f: ExportFormat) {
  format.value = f;
  if (exportBlobUrl) {
    URL.revokeObjectURL(exportBlobUrl);
    exportBlobUrl = null;
  }
}

async function removeHistoryItem(id: string) {
  try {
    await deleteHistory(id);
    await loadHistory();
  } catch (err) {
    errorMsg.value = `${i18n.t('error.deleteFailed')}: ${(err as Error).message}`;
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
          class="icon-btn lang"
          :style="{ color: t().textMuted }"
          :title="i18n.t('app.language')"
          :aria-label="i18n.t('app.language')"
          @click="i18n.toggleLocale()"
        >
          {{ i18n.locale.value === 'en' ? '中' : 'EN' }}
        </button>
        <button
          class="icon-btn"
          :style="{ color: t().textMuted }"
          :title="i18n.t('app.help')"
          :aria-label="i18n.t('app.help')"
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
        :disabled="status === 'starting' || status === 'selecting' || status === 'capturing' || status === 'finalizing'"
        @click="captureFull"
      >
        <span class="card-icon">📷</span>
        <span class="card-label">{{ i18n.t('capture.full') }}</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
        :disabled="status === 'starting' || status === 'selecting' || status === 'capturing' || status === 'finalizing'"
        @click="captureRegion"
      >
        <span class="card-icon">▭</span>
        <span class="card-label">{{ i18n.t('capture.region') }}</span>
      </button>
      <button
        class="card"
        :style="{
          background: t().surface,
          color: t().text,
          borderColor: t().border,
        }"
        @click="toggleHistory"
      >
        <span class="card-icon">⏱</span>
        <span class="card-label">{{ i18n.t('capture.history') }}</span>
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
        <span class="card-label">{{ i18n.t('capture.shortcuts') }}</span>
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
      <div v-if="status === 'starting'" class="status-line">
        {{ i18n.t('status.preparing') }}
      </div>
      <div v-else-if="status === 'selecting'" class="status-line">
        {{ i18n.t('status.selecting') }}
      </div>
      <div v-else-if="status === 'capturing' && progress" class="status-line">
        {{ i18n.t('status.capturing') }} {{ progress.i + 1 }} / {{ progress.total }}
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
      <div v-else-if="status === 'finalizing'" class="status-line">
        {{ i18n.t('status.finalizing') }}
      </div>
      <div v-else-if="status === 'done' && result" class="status-line">
        ✅ {{ i18n.t('status.done') }} · {{ Math.round(result.byteSize / 1024) }} KB ·
        {{ result.width }}×{{ result.height }}

        <!-- Preview of the actual capture. Users want to see what they got
             before downloading it; the blob URL is already local. -->
        <div
          class="preview"
          :style="{
            background: t().surfaceAlt,
            borderColor: t().border,
          }"
        >
          <img
            :src="result.blobUrl"
            :alt="i18n.t('status.previewAlt')"
            class="preview-img"
          />
        </div>

        <!-- Format picker (PNG / JPG / PDF) -->
        <div class="formats">
          <button
            v-for="f in (['png', 'jpg', 'pdf'] as ExportFormat[])"
            :key="f"
            class="fmt-btn"
            :class="{ active: format === f }"
            :style="
              format === f
                ? { background: t().brand, color: t().brandFg, borderColor: t().brand }
                : { background: t().surface, color: t().text, borderColor: t().border }
            "
            @click="onFormatChange(f)"
          >
            {{ f.toUpperCase() }}
          </button>
        </div>

        <div class="row">
          <button
            class="dl-btn"
            :style="{ background: t().brand, color: t().brandFg }"
            :disabled="exporting"
            @click="downloadResult"
          >
            {{ exporting ? i18n.t('action.working') : i18n.t('action.download') }}
          </button>
          <button
            class="dl-btn secondary"
            :style="{ background: t().surface, color: t().text, borderColor: t().border }"
            @click="copyToClipboard"
          >
            {{ copied ? i18n.t('action.copied') : i18n.t('action.copy') }}
          </button>
          <button
            class="dl-btn secondary"
            :style="{ background: t().surface, color: t().text, borderColor: t().border }"
            :disabled="saving"
            @click="saveToHistory"
          >
            {{ saving ? i18n.t('action.saving') : i18n.t('action.save') }}
          </button>
        </div>
      </div>
      <div v-else-if="status === 'error'" class="status-line error">
        ❌ {{ errorMsg }}
      </div>
    </section>

    <!-- History panel (D+3) -->
    <section
      v-if="showHistory"
      class="history"
      :style="{
        background: t().surfaceAlt,
        color: t().text,
        borderColor: t().border,
      }"
    >
      <div class="history-head">
        <span>{{ i18n.t('history.title') }} ({{ historyItems.length }})</span>
        <button class="close-btn" @click="showHistory = false">✕</button>
      </div>
      <div v-if="historyItems.length === 0" class="history-empty">
        {{ i18n.t('history.empty') }}
      </div>
      <ul v-else class="history-list">
        <li v-for="item in historyItems" :key="item.id" class="history-item">
          <div class="history-meta">
            <div class="history-title" :title="item.meta.title">
              {{ item.meta.title }}
            </div>
            <div class="history-sub">
              {{ item.meta.width }}×{{ item.meta.height }} ·
              {{ Math.round(item.meta.size / 1024) }} KB ·
              {{ new Date(item.meta.capturedAt).toLocaleString() }}
            </div>
          </div>
          <button class="del-btn" @click="removeHistoryItem(item.id)">
            {{ i18n.t('action.delete') }}
          </button>
        </li>
      </ul>
    </section>

    <footer
      class="footer"
      :style="{
        background: t().surfaceAlt,
        color: t().textMuted,
        borderColor: t().border,
      }"
    >
      {{ i18n.t('footer.pro') }}
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
/* The language toggle shows a two-letter label ("EN" / "中"), not an
   emoji — it needs a slightly smaller, tighter type treatment. */
.icon-btn.lang {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  min-width: 28px;
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
/* Preview of the captured image. A full-page capture is very tall, so
   `contain` would shrink the whole thing down to an unreadable sliver.
   `cover` + `object-position: top` keeps the page at full popup width and
   shows the top of it, which is what people actually want to check. */
.preview {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 6px;
  overflow: hidden;
  height: 132px;
  background: #ffffff;
}
.preview-img {
  width: 100%;
  height: 132px;
  object-fit: cover;
  object-position: top center;
  display: block;
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
.dl-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dl-btn.secondary {
  border: 1px solid;
}
.row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.formats {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.fmt-btn {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
}

.history {
  margin: 0 16px 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid;
  font-size: 12px;
  max-height: 220px;
  overflow-y: auto;
}
.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 6px;
}
.close-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: inherit;
  opacity: 0.6;
}
.history-empty {
  opacity: 0.6;
  padding: 8px 0;
}
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.2);
}
.history-meta {
  min-width: 0;
  flex: 1;
}
.history-title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-sub {
  font-size: 11px;
  opacity: 0.6;
}
.del-btn {
  background: transparent;
  border: 1px solid;
  border-radius: 5px;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  color: inherit;
}

.footer {
  text-align: center;
  font-size: 12px;
  padding: 12px 16px;
  border-top: 1px solid;
  margin-top: 8px;
}
</style>
