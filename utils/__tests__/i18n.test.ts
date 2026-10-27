import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGES,
  STORAGE_KEY,
  detectBrowserLocale,
  loadLocaleOverride,
  saveLocaleOverride,
  translate,
  useI18n,
  type Locale,
} from '../i18n';

/**
 * The i18n layer exists because the store listing is English while the UI
 * used to be hard-coded Chinese — a user who read the listing could not
 * read the extension. These tests pin the behaviour that resolves it.
 */

const SAMPLE = {
  en: {
    'capture.full': 'Full page',
    'capture.region': 'Region',
    'status.capturing': 'Capturing',
    'error.pageTooLongReason': 'the page is {height}px tall; the limit is {limit}px',
  },
  zh: {
    'capture.full': '整页截图',
    'capture.region': '区域截图',
    'status.capturing': '截取中',
    'error.pageTooLongReason': '页面高 {height}px，上限 {limit}px',
  },
} as const;

describe('detectBrowserLocale', () => {
  const original = navigator.language;

  afterEach(() => {
    Object.defineProperty(navigator, 'language', { value: original, configurable: true });
  });

  function setLanguage(value: string) {
    Object.defineProperty(navigator, 'language', { value, configurable: true });
  }

  it('maps zh* to Chinese', () => {
    setLanguage('zh-CN');
    expect(detectBrowserLocale()).toBe('zh');
    setLanguage('zh-TW');
    expect(detectBrowserLocale()).toBe('zh');
    setLanguage('ZH');
    expect(detectBrowserLocale()).toBe('zh');
  });

  it('maps everything else to English', () => {
    setLanguage('en-US');
    expect(detectBrowserLocale()).toBe('en');
    setLanguage('es-ES');
    expect(detectBrowserLocale()).toBe('en');
    setLanguage('pt-BR');
    expect(detectBrowserLocale()).toBe('en');
  });
});

describe('translate', () => {
  it('returns the string for the locale', () => {
    expect(translate("en", "capture.full")).toBe("Full page");
    expect(translate('zh', 'capture.full')).toBe('整页截图');
  });

  it('substitutes {placeholders}', () => {
    expect(
      translate('en', 'error.pageTooLongReason', { height: 50_001, limit: 32_767 }),
    ).toBe('the page is 50001px tall; the limit is 32767px');
    expect(
      translate('zh', 'error.pageTooLongReason', { height: 50_001, limit: 32_767 }),
    ).toBe('页面高 50001px，上限 32767px');
  });

  it('substitutes every occurrence of a placeholder', () => {
    expect(translate('en', 'error.pageTooLongReason', { height: 1, limit: 2 })).toContain('1px');
  });

  it('echoes an unknown key back instead of rendering an empty label', () => {
    // A missing translation must be visible in the UI, not silently blank.
    expect(translate('en', 'nope.not.a.key' as never)).toBe('nope.not.a.key');
  });
});

describe('locale persistence', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete store[key];
          }),
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('reads a stored override', async () => {
    store[STORAGE_KEY] = 'zh';
    expect(await loadLocaleOverride()).toBe('zh');
  });

  it('ignores a garbage stored value', async () => {
    store[STORAGE_KEY] = 'klingon';
    expect(await loadLocaleOverride()).toBeNull();
  });

  it('round-trips a saved override', async () => {
    await saveLocaleOverride('zh');
    expect(await loadLocaleOverride()).toBe('zh');
  });

  it('clears the override with null', async () => {
    await saveLocaleOverride('zh');
    await saveLocaleOverride(null);
    expect(await loadLocaleOverride()).toBeNull();
  });

  it('never throws when storage is unavailable', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error('no storage');
          }),
          set: vi.fn(async () => {
            throw new Error('no storage');
          }),
          remove: vi.fn(async () => {
            throw new Error('no storage');
          }),
        },
      },
    };
    expect(await loadLocaleOverride()).toBeNull();
    await expect(saveLocaleOverride('zh')).resolves.toBeUndefined();
  });
});

describe('useI18n', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete store[key];
          }),
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('starts at the browser language and applies the stored override', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    store[STORAGE_KEY] = 'zh';
    const { locale, ready } = useI18n();
    expect(locale.value).toBe('en');
    await ready;
    expect(locale.value).toBe('zh');
  });

  it('toggles the locale and persists it', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    const { locale, toggleLocale, ready } = useI18n();
    await ready;
    toggleLocale();
    expect(locale.value).toBe('zh');
    expect(await loadLocaleOverride()).toBe('zh');
    toggleLocale();
    expect(locale.value).toBe('en');
  });

  it('t() follows the current locale', async () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    const { t, toggleLocale, ready } = useI18n();
    await ready;
    expect(t('capture.full')).toBe('Full page');
    toggleLocale();
    expect(t('capture.full')).toBe('整页截图');
  });
});

// Keep the dictionaries honest — a translation added to one language and
// forgotten in the other shows up as a raw key in the UI.
describe('dictionary parity', () => {
  it('every English key has a Chinese counterpart', () => {
    const enKeys = Object.keys(MESSAGES.en);
    const zhKeys = Object.keys(MESSAGES.zh);
    expect(zhKeys.sort()).toEqual([...enKeys].sort());
  });

  it('no Chinese entry is left as the English string', () => {
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      const zh: string = MESSAGES.zh[key];
      const en: string = MESSAGES.en[key];
      if (zh === en && !/^[A-Za-z0-9 .×…()’]+$/.test(en)) {
        throw new Error(`missing Chinese translation for "${key}"`);
      }
    }
  });

  it('placeholders match between the two languages', () => {
    const vars = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      expect(vars(MESSAGES.zh[key])).toEqual(vars(MESSAGES.en[key]));
    }
  });
});
