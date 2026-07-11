import { describe, expect, it } from 'vitest';
import { theme, themeCssVars } from '../theme';

describe('theme tokens (architecture v1.2 §4.5)', () => {
  it('light mode brand uses teal-700 for WCAG AA contrast', () => {
    expect(theme.light.brand).toBe('#0F766E');
    expect(theme.light.brandName).toBe('teal-700');
    expect(theme.light.brandFg).toBe('#FFFFFF');
  });

  it('dark mode brand uses teal-500 for high contrast on dark bg', () => {
    expect(theme.dark.brand).toBe('#14B8A6');
    expect(theme.dark.brandName).toBe('teal-500');
    expect(theme.dark.brandFg).toBe('#0A0A0A');
  });

  it('theme CSS vars expose all tokens', () => {
    const css = themeCssVars('light');
    expect(css).toContain('--shotly-brand:#0F766E');
    expect(css).toContain('--shotly-text:');
    expect(css).toContain('--shotly-shadow:');
  });
});