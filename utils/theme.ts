/**
 * Theme tokens (architecture v1.2 §4.5)
 *
 * Brand: mint #2DD4BF (a11y-light bg fails WCAG AA 4.5:1)
 * Light mode FIX: use teal-700 #0F766E as button bg (6.86:1 contrast)
 * Dark mode:     teal-500 #14B8A6 bg + near-black #0A0A0A fg (7.12:1)
 * Auto-detect via prefers-color-scheme.
 *
 * These are exposed as a plain object so popup / options / offscreen can
 * import without bringing in vanilla-extract at scaffold time. The final
 * UI will wrap these in vanilla-extract recipes per architecture §1.5.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeToken {
  bg: string;
  fg: string;
  border: string;
  text: string;
  textMuted: string;
  surface: string;
  surfaceAlt: string;
  brand: string;
  brandFg: string;
  brandName: string;
  shadow: string;
}

export const theme = {
  light: {
    bg: '#FAFAF7',
    fg: '#18181B',
    border: '#E4E4E7',
    text: '#18181B',
    textMuted: '#71717A',
    surface: '#FFFFFF',
    surfaceAlt: '#F4F4F5',
    brand: '#0F766E', // teal-700 — primary button bg (6.86:1 contrast)
    brandFg: '#FFFFFF',
    brandName: 'teal-700',
    shadow: '0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(15,118,110,0.08)',
  } satisfies ThemeToken,

  dark: {
    bg: '#0A0A0A',
    fg: '#FAFAFA',
    border: '#27272A',
    text: '#FAFAFA',
    textMuted: '#A1A1AA',
    surface: '#18181B',
    surfaceAlt: '#27272A',
    brand: '#14B8A6', // teal-500 — primary button bg (7.12:1 contrast)
    brandFg: '#0A0A0A',
    brandName: 'teal-500',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 4px 12px rgba(20,184,166,0.18)',
  } satisfies ThemeToken,
};

/** Detect current OS theme — Chrome exposes matchMedia on prefers-color-scheme. */
export function detectTheme(): ThemeMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** React to theme changes (call once at popup mount). */
export function watchTheme(cb: (mode: ThemeMode) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => cb(mq.matches ? 'dark' : 'light');
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/** CSS variable block (string-typed for injecting into shadow DOM or inline style). */
export function themeCssVars(mode: ThemeMode): string {
  const t = theme[mode];
  return [
    `--shotly-bg:${t.bg}`,
    `--shotly-fg:${t.fg}`,
    `--shotly-border:${t.border}`,
    `--shotly-text:${t.text}`,
    `--shotly-text-muted:${t.textMuted}`,
    `--shotly-surface:${t.surface}`,
    `--shotly-surface-alt:${t.surfaceAlt}`,
    `--shotly-brand:${t.brand}`,
    `--shotly-brand-fg:${t.brandFg}`,
    `--shotly-shadow:${t.shadow}`,
  ].join(';');
}