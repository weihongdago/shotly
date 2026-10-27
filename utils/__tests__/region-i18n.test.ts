import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import { MIN_REGION_SIZE } from '../region-selector';

/**
 * The region-selection overlay is drawn **on the page**, not in the popup.
 * It used to carry hard-coded Chinese copy, which meant an English-locale
 * user was greeted by a Chinese hint bar while the store listing — and
 * the popup next to it — were in English.
 *
 * These tests pin the localized strings the content script passes in.
 */

describe('region overlay i18n', () => {
  it('renders the hint in English', () => {
    const hint = translate('en', 'region.hint', { min: MIN_REGION_SIZE });
    expect(hint).toBe('Drag to select a region · min 100×100 · Esc to cancel');
    expect(hint).not.toMatch(/[一-龥]/);
  });

  it('renders the hint in Chinese', () => {
    const hint = translate('zh', 'region.hint', { min: MIN_REGION_SIZE });
    expect(hint).toBe('拖拽框选区域 · 最小 100×100 · Esc 取消');
  });

  it('renders the too-small toast in English', () => {
    const msg = translate('en', 'region.tooSmall', { min: MIN_REGION_SIZE });
    expect(msg).toBe('Selection too small (min 100×100px) — drag again');
    expect(msg).not.toMatch(/[一-龥]/);
  });

  it('renders the too-small toast in Chinese', () => {
    const msg = translate('zh', 'region.tooSmall', { min: MIN_REGION_SIZE });
    expect(msg).toBe('选区太小（至少 100×100px），请重新拖拽');
  });

  it('interpolates the minimum size into both languages', () => {
    for (const locale of ['en', 'zh'] as const) {
      const hint = translate(locale, 'region.hint', { min: 250 });
      expect(hint).toContain('250');
      const msg = translate(locale, 'region.tooSmall', { min: 250 });
      expect(msg).toContain('250');
    }
  });

  it('the plain hint variant exists in both languages', () => {
    expect(translate('en', 'region.hintPlain')).toContain('Esc to cancel');
    expect(translate('zh', 'region.hintPlain')).toContain('Esc 取消');
  });
});
