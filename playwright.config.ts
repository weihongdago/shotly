import { defineConfig, devices } from '@playwright/test';

/**
 * Shotly Playwright 配置（E2E 测试基础设施 / B3 交付）
 *
 * 设计要点：
 *   - 使用 Playwright bundled Chromium（不能用 channel: 'chrome'，
 *     Chrome stable 拒绝 --load-extension，加载不了 MV3 扩展）
 *   - MV3 扩展必须用 launchPersistentContext + --load-extension + --disable-extensions-except
 *   - v1.0 仅测 Chrome Stable / Beta / Dev 三轨（架构 §4.2 锁定）
 *   - Edge / Brave / Arc 由 D+10 兼容性扫尾阶段覆盖
 *
 * ⚠️ 这个套件以前住在 workspace 仓库的 test-infra/ 里，
 *    **CI 从来没跑过它** —— 29 个 E2E（含隐私「无网络请求」守门）
 *    全靠人工本地跑。2026-10-28 搬进 shotly 仓库，CI 才真能跑。
 *    见 .github/workflows/e2e.yml。
 *
 * 配套文档：
 *   test-plan-v1.md §2.2 / §4 / §11
 */

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // MV3 测试有共享 user-data-dir 风险，串行更稳
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // ── E2E（用 Playwright 自带 Chromium / Chrome for Testing） ──
    // 注意：不能用 channel: 'chrome'（Google Chrome stable 拒绝
    // --disable-extensions-except 与 --load-extension，无法加载 MV3 扩展）。
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 不用 channel，让 Playwright 走 bundled Chromium
      },
    },
    // ── Beta 通道（D+5 后启用，需要本地装了 Chrome Beta） ──
    // {
    //   name: 'chrome-beta',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome-beta' },
    // },
    // ── Dev 通道（D+10 后启用） ──
    // {
    //   name: 'chrome-dev',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome-dev' },
    // },
  ],
});