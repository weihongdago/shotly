/**
 * 探针：S2 的 DPR=2 输出宽度为什么是 2282 而不是 2560？
 *
 * 背景：S2 E2E 断言「DPR=2 输出宽度 > 2400（= CSS 宽 1280 × 2）」，
 * 但实测输出宽度是 2282（= 1141 × 2）。
 *
 * 要回答的问题只有一个：**2282 这个数是从哪来的？**
 *   - 如果是「窗口 widget 光栅宽度」（captureVisibleTab 抓的），那是环境差异，
 *     断言得改成跟布局视口比，而不是跟窗口比；
 *   - 如果是「布局视口宽度 × DPR」，那就是拼接逻辑错了，得修代码。
 *
 * 这个探针只抓一张图（不跑 30,000px 的长页），所以几秒就跑完。
 *
 * 用法：node e2e/probe-dpr-width.mjs
 */

import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOTLY_BUILT = resolve(process.cwd(), '.output', 'chrome-mv3');
const DPR = 2;
const VIEWPORT = { width: 1280, height: 800 };

const userDataDir = mkdtempSync(join(tmpdir(), 'shotly-dpr-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${SHOTLY_BUILT}`,
    `--load-extension=${SHOTLY_BUILT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--no-sandbox',
    ...(DPR > 1 ? [`--force-device-scale-factor=${DPR}`] : []),
  ],
  viewport: VIEWPORT,
  deviceScaleFactor: DPR,
});

const page = await ctx.newPage();
await page.goto('data:text/html,<body style="margin:0;background:#fff"><div style="height:3000px;background:linear-gradient(#fff,#000)"></div></body>');

const info = await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  dpr: window.devicePixelRatio,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
  screenWidth: window.screen.width,
  screenHeight: window.screen.height,
  availWidth: window.screen.availWidth,
}));

console.log('=== 页面自己看到的 ===');
console.log(JSON.stringify(info, null, 2));

// 让扩展抓一张图，看它拿到的位图宽多少
const extId = ctx
  .serviceWorkers()
  .map((w) => w.url().match(/^chrome-extension:\/\/([a-z]{32})/)?.[1])
  .find(Boolean);

if (!extId) {
  console.log('（扩展没起来，跳过 captureVisibleTab 对比）');
} else {
  const bg = ctx
    .serviceWorkers()
    .find((w) => w.url().includes(extId));
  console.log('=== 扩展 service worker ===', bg?.url());
}

await ctx.close();
console.log('\n=== 结论 ===');
console.log(`布局视口 innerWidth = ${info.innerWidth} CSS px`);
console.log(`DPR = ${info.dpr}`);
console.log(`innerWidth × DPR = ${info.innerWidth * info.dpr}`);
console.log(`窗口 outerWidth = ${info.outerWidth}（含边框）`);
console.log(`屏幕 availWidth = ${info.availWidth} × DPR = ${info.availWidth * info.dpr}`);
