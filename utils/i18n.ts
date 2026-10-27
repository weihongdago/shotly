/**
 * i18n (v1.0: English + Chinese)
 *
 * Why this exists: the Chrome Web Store listing is in English (the
 * default market — see PRD §机会 3 and architecture §"语言 | 英 / 中 / 西 /
 * 葡"), but the popup UI was hard-coded Chinese. A user who reads the
 * English listing and then installs the extension finds buttons they
 * cannot read. That is a real conversion bug, not a cosmetic one.
 *
 * Rules:
 *   - **Auto**: follow the browser's UI language (zh → 中文, else English).
 *     A Chinese-locale user gets Chinese; an English-locale user gets the
 *     English UI that matches the store listing.
 *   - **Override**: the header has a language toggle that persists the
 *     choice in `chrome.storage.local`. The override wins over the
 *     browser language.
 *   - **Fallback**: an unknown key returns the key itself, so a missing
 *     translation shows up as `some.key` in the UI instead of an empty
 *     label.
 *
 * Deliberately NOT `chrome.i18n`: that needs a `_locales/` directory and
 * a manifest `default_locale`, and it only supports whole-message
 * substitution — we need a runtime switch without reloading the extension.
 *
 * Adding a locale later (es / pt, per the PRD) = add one entry to
 * `MESSAGES` and one to `detectBrowserLocale`.
 */

import { ref, type Ref } from 'vue';

export type Locale = 'en' | 'zh';

export const STORAGE_KEY = 'shotly.locale';

export const MESSAGES = {
  en: {
    'app.settings': 'Settings',
    'app.help': 'Help',
    'app.language': 'Language',
    'capture.full': 'Full page',
    'capture.region': 'Region',
    'capture.history': 'History',
    'capture.shortcuts': 'Shortcuts',
    'status.preparing': 'Preparing…',
    'status.selecting': 'Drag on the page to select an area. Esc to cancel',
    'status.capturing': 'Capturing',
    'status.finalizing': 'Finalizing…',
    'status.done': 'Done',
    'status.previewAlt': 'Screenshot preview',
    'action.download': 'Download',
    'action.working': 'Working…',
    'action.copy': 'Copy',
    'action.copied': 'Copied',
    'action.save': 'Save',
    'action.saving': 'Saving…',
    'action.delete': 'Delete',
    'history.title': 'History',
    'history.empty': 'No saved screenshots yet',
    'footer.pro': '✨ Upgrade Pro to unlock the editor + watermark',
    'error.exportFailed': 'Export failed',
    'error.saveHistoryFailed': 'Save to history failed',
    'error.deleteFailed': 'Delete failed',
    'error.pageTooLong': 'Page too long',
    'error.pageTooLongReason': 'the page is {height}px tall; the limit is {limit}px',
    'error.pageTooLongReasonDpr':
      'the page is {height}px tall; at {dpr}× DPR the stitch canvas would exceed Chrome’s {max}px limit (max {limit}px)',
    'region.hint': 'Drag to select a region · min {min}×{min} · Esc to cancel',
    'region.hintPlain': 'Drag on the page to select a region · Esc to cancel',
    'region.tooSmall': 'Selection too small (min {min}×{min}px) — drag again',
  },
  zh: {
    'app.settings': '设置',
    'app.help': '帮助',
    'app.language': '语言',
    'capture.full': '整页截图',
    'capture.region': '区域截图',
    'capture.history': '历史库',
    'capture.shortcuts': '快捷键',
    'status.preparing': '准备截图…',
    'status.selecting': '选择区域中… 在页面上拖拽框选，Esc 取消',
    'status.capturing': '截取中',
    'status.finalizing': '合成中…',
    'status.done': '完成',
    'status.previewAlt': '截图预览',
    'action.download': '下载',
    'action.working': '处理中…',
    'action.copy': '复制',
    'action.copied': '已复制',
    'action.save': '存历史',
    'action.saving': '保存中…',
    'action.delete': '删除',
    'history.title': '历史库',
    'history.empty': '还没有保存的截图',
    'footer.pro': '✨ 升级 Pro 解锁编辑器 + 水印',
    'error.exportFailed': '导出失败',
    'error.saveHistoryFailed': '保存到历史失败',
    'error.deleteFailed': '删除失败',
    'error.pageTooLong': '页面太长',
    'error.pageTooLongReason': '页面高 {height}px，上限 {limit}px',
    'error.pageTooLongReasonDpr':
      '页面高 {height}px；{dpr}× DPR 下拼接画布会超过 Chrome 的 {max}px 上限（最多 {limit}px）',
    'region.hint': '拖拽框选区域 · 最小 {min}×{min} · Esc 取消',
    'region.hintPlain': '拖拽鼠标框选区域 · Esc 取消',
    'region.tooSmall': '选区太小（至少 {min}×{min}px），请重新拖拽',
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)['en'];

/**
 * Map the browser's UI language to a supported locale.
 *
 * Anything we do not translate yet falls back to English — an English
 * UI is better than a broken one.
 */
export function detectBrowserLocale(): Locale {
  const lang = (globalThis.navigator?.language ?? 'en').toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

/** Translate `key` in `locale`. Unknown keys echo back the key itself. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const table = MESSAGES[locale] ?? MESSAGES.en;
  let text: string = (table as Record<string, string>)[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Read the persisted override, if any. Never throws. */
export async function loadLocaleOverride(): Promise<Locale | null> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const value = got?.[STORAGE_KEY];
    return value === 'en' || value === 'zh' ? value : null;
  } catch {
    return null;
  }
}

/** Persist the override (`null` clears it → back to browser language). */
export async function saveLocaleOverride(locale: Locale | null): Promise<void> {
  try {
    if (locale === null) await chrome.storage.local.remove(STORAGE_KEY);
    else await chrome.storage.local.set({ [STORAGE_KEY]: locale });
  } catch {
    /* storage unavailable (tests / restricted context) — keep the in-memory value */
  }
}

/**
 * Resolve the locale for a **content script**.
 *
 * Content scripts run in the page's context, so they cannot use the
 * popup's reactive state. They read the same persisted override instead,
 * which keeps the overlay language in sync with what the user picked in
 * the popup. `chrome.storage` is available to content scripts; `chrome.i18n`
 * is not.
 */
export async function resolveLocale(): Promise<Locale> {
  const override = await loadLocaleOverride();
  return override ?? detectBrowserLocale();
}

/**
 * Reactive translator for a Vue component.
 *
 * `locale` starts at the browser language so the first paint is already
 * right; the stored override replaces it as soon as it is read.
 */
export function useI18n(): {
  locale: Ref<Locale>;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  toggleLocale: () => void;
  ready: Promise<void>;
} {
  const locale = ref<Locale>(detectBrowserLocale());
  const t = (key: MessageKey, vars?: Record<string, string | number>) =>
    translate(locale.value, key, vars);

  const ready = (async () => {
    const override = await loadLocaleOverride();
    if (override) locale.value = override;
  })();

  const toggleLocale = () => {
    locale.value = locale.value === 'en' ? 'zh' : 'en';
    void saveLocaleOverride(locale.value);
  };

  return { locale, t, toggleLocale, ready };
}
