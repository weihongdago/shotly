import { defineConfig } from 'wxt';

// Shotly — WXT configuration (architecture v1.2 §1.1, §4.1)
// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],

  manifest: {
    name: 'Shotly',
    description:
      'Modern whole-page screenshot tool. Capture, annotate, export. Privacy-first, no upload.',
    // Declares the manifest strings' locale. Without it Chrome treats the
    // extension as "English" and *never* shows a localized store listing
    // to a Chinese user — even if one was uploaded. `public/_locales/`
    // holds the per-locale overrides (see utils/i18n.ts for the runtime
    // UI switch, which is a separate mechanism).
    default_locale: 'en',
    permissions: [
      'activeTab',
      'scripting',
      'offscreen',
      'storage',
      'downloads',
      'clipboardWrite',
      'unlimitedStorage',
      'tabs',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Shotly — Capture whole page',
      default_popup: 'popup.html',
    },
    background: {
      type: 'module',
    },
    // content_scripts is auto-generated from entrypoints/content.ts
    // — do NOT redeclare here or the manifest will contain duplicates.
    web_accessible_resources: [
      {
        // Only `offscreen.html` exists. Listing a non-existent resource
        // (e.g. a planned `editor.html`) makes Chrome log a manifest
        // warning on every load.
        resources: ['offscreen.html'],
        matches: ['<all_urls>'],
      },
    ],
    commands: {
      'capture-full-page': {
        suggested_key: {
          default: 'Alt+Shift+S',
          mac: 'Alt+Shift+S',
        },
        description: 'Capture the entire current page',
      },
      'capture-visible': {
        suggested_key: {
          default: 'Alt+Shift+V',
          mac: 'Alt+Shift+V',
        },
        description: 'Capture the visible viewport only',
      },
    },
  },

  // Vite tweaks: keep small bundle for popup
  vite: () => ({
    build: {
      target: 'esnext',
    },
  }),
});