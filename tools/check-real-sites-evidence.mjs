#!/usr/bin/env node
/**
 * 真实站点冒烟的「证据守门」—— **这个体检到底测到了东西没有？**
 *
 * ## 为什么需要
 *
 * `real-sites.yml` 是个**不阻塞合并**的定时 workflow（每天跑一次）。
 * 它对「网络不可达」的站点是 `test.skip(...)` —— 而 Playwright 里
 * **全部用例被 skip 时 exit code 仍是 0**。
 *
 * 于是出现这个局面：
 *
 *   - 6 个站点全部因为网络不可达被跳过
 *   - `pnpm test:e2e:real` 退出码 0 → workflow **绿**
 *   - artifact 照样上传（`afterAll` 无论有没有真跑都会写报告）→
 *     `if-no-files-found: error` 也**不会**触发
 *
 * 而这个 workflow 的**全部价值**就是「每天看一眼 Shotly 在真实网站上还活着吗」。
 * 它变成「每天都绿」之后，看的人会得出「Shotly 在真实网站上没问题」——
 * 而这个结论可能**一个站点都没测**换来的。
 *
 * ⚠️ 这一条比 [[silent-skip-is-worse-than-hard-failure]] 更隐蔽一层：
 *    主门禁（合并门禁）已经有「skipped 必须为 0」的守门，
 *    于是人会下意识地认为「守门这套体系已经覆盖了跳过问题」——
 *    **但每个 workflow 的守门只覆盖自己那套 runner。**
 *
 * 「不阻塞合并」这个设计决定本身是**对的**（网络抖动不该把主门禁拉红），
 * 错的是**只做了「不阻塞」，没做「可证伪」**。
 *
 * ## 判定
 *
 * | 情况 | 判定 | 为什么 |
 * |---|---|---|
 * | 报告文件不存在 | **硬失败** | spec 根本没跑起来（守门自己坏了） |
 * | 报告不是合法 JSON | **硬失败** | 同上 |
 * | 报告里一条都没有 | **硬失败** | spec 跑了但什么都没记录 |
 * | 全部站点网络不可达 | **硬失败**（消息里说明是网络原因） | 「没测到」≠「测过了」 |
 * | 有站点真的测了 | 通过 | 拿到了证据 |
 *
 * 「真的测了」= `status` 是 `done`（抓成功）或 `too-long`（**正确拒绝**，
 * 也是产品的真实结论），且 `networkUnreachable` 不为真。
 *
 * ⚠️ 为什么 `too-long` 算「测到了」：
 *    「页面太长 → 明确拒绝并建议改用区域截图」是**产品行为的正确输出**，
 *    不是失败，更不是「没测」。把这种站点算成「没测」会让守门误报。
 *
 * ## 门槛
 *
 * 默认要求**至少 1 个**站点真的测了（`REAL_SITES_MIN_TESTED` 可调）。
 * 只测到 1 个也会**通过**，但会在 summary 里写明「实测 1/6」——
 * 部分覆盖不阻塞，但必须**看得见**。
 *
 * 用法：
 *   node tools/check-real-sites-evidence.mjs [报告路径]
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_REPORT = resolve(
  process.cwd(),
  'reports',
  'real-sites',
  'real-sites-report.json',
);

/** 算「真的测了」的两种结论。 */
const TESTED_STATUSES = new Set(['done', 'too-long']);

/**
 * @typedef {object} SiteReport
 * @property {string} id
 * @property {string} label
 * @property {string} url
 * @property {string} status
 * @property {number} pageHeight
 * @property {number} byteSize
 * @property {string | null} [error]
 * @property {boolean} [networkUnreachable]
 */

/**
 * 把报告分类。
 *
 * ⚠️ 「网络不可达」的判定**两个来源都认**：
 *    - `networkUnreachable === true`（spec 显式标的）
 *    - `status === 'network-unreachable'`（spec 写的状态值）
 *    只认一个的话，另一个来源的写法变了就会**静默变成「测过了」**。
 *
 * @param {SiteReport[]} entries
 */
export function classify(entries) {
  const tested = [];
  const network = [];
  const other = [];

  for (const e of entries) {
    if (!e || typeof e !== 'object') {
      other.push(e);
      continue;
    }
    const unreachable =
      e.networkUnreachable === true || e.status === 'network-unreachable';
    if (unreachable) {
      network.push(e);
    } else if (TESTED_STATUSES.has(e.status)) {
      tested.push(e);
    } else {
      other.push(e);
    }
  }

  return { tested, network, other };
}

/**
 * 读报告 + 判定。
 *
 * @param {string} reportPath
 * @returns {{ok: boolean, reason: string, total: number, tested: number, network: number, other: number, lines: string[]}}
 */
export function evaluate(reportPath) {
  const lines = [];

  if (!existsSync(reportPath)) {
    return {
      ok: false,
      reason:
        `找不到真实站点报告：${reportPath}\n` +
        `说明 spec 根本没跑到写报告那一步 —— 这不是「测过了」，是「什么都没测」。`,
      total: 0,
      tested: 0,
      network: 0,
      other: 0,
      lines,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      reason:
        `真实站点报告不是合法 JSON：${reportPath}\n` +
        `解析失败：${err instanceof Error ? err.message : String(err)}\n` +
        `守门自己坏了 —— 这比「测到 0 个站点」更严重。`,
      total: 0,
      tested: 0,
      network: 0,
      other: 0,
      lines,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `真实站点报告的顶层不是数组：${reportPath}`,
      total: 0,
      tested: 0,
      network: 0,
      other: 0,
      lines,
    };
  }

  const { tested, network, other } = classify(parsed);

  for (const e of tested) {
    lines.push(
      `✅ ${e.label ?? e.id} —— ${e.status}` +
        (e.pageHeight ? `（${e.pageHeight}px）` : '') +
        (e.error ? `｜${e.error}` : ''),
    );
  }
  for (const e of network) {
    lines.push(
      `⚠️ ${e.label ?? e.id} —— 网络不可达（与 Shotly 无关）` +
        (e.error ? `｜${e.error}` : ''),
    );
  }
  for (const e of other) {
    const id = e && typeof e === 'object' ? (e.label ?? e.id ?? '未知') : '未知';
    const st = e && typeof e === 'object' ? e.status : '(坏条目)';
    lines.push(`❓ ${id} —— 状态异常：${st}`);
  }

  const total = parsed.length;
  const min = Number(process.env.REAL_SITES_MIN_TESTED ?? '1');

  if (total === 0) {
    return {
      ok: false,
      reason:
        `真实站点报告里一条记录都没有 —— spec 跑了但什么都没测到。\n` +
        `「全绿」在这里等于「没测」，必须看见。`,
      total: 0,
      tested: 0,
      network: 0,
      other: 0,
      lines,
    };
  }

  if (tested.length < min) {
    const allNetwork = network.length === total;
    const reason = allNetwork
      ? [
          `真实站点冒烟：**一个站点都没测到**（${total}/${total} 因网络不可达被跳过）。`,
          ``,
          `这是**网络问题**，不是 Shotly 的问题 —— 但它也**不是「测过了」**。`,
          `这个 workflow 的全部价值就是「证明 Shotly 在真实网站上还活着」，`,
          `今天它什么都没证明，却显示绿灯。`,
          ``,
          `想手动复跑：Actions → Real-site smoke → Run workflow`,
        ].join('\n')
      : [
          `真实站点冒烟：只测到 ${tested.length} 个站点（门槛 ${min} 个）。`,
          `其余站点既不是「测了」也不是「网络不可达」—— 状态异常，报告见下。`,
        ].join('\n');

    return {
      ok: false,
      reason,
      total,
      tested: tested.length,
      network: network.length,
      other: other.length,
      lines,
    };
  }

  return {
    ok: true,
    reason:
      `真实站点冒烟：实测 ${tested.length}/${total} 个站点` +
      (network.length ? `（${network.length} 个网络不可达）` : '') +
      (other.length ? `（${other.length} 个状态异常）` : ''),
    total,
    tested: tested.length,
    network: network.length,
    other: other.length,
    lines,
  };
}

/**
 * 写进 GitHub Actions 的 job summary（可选，没有这个环境变量就跳过）。
 */
function writeStepSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    appendFileSync(target, text, 'utf8');
  } catch {
    // summary 写不进去不该让守门失败 —— 判定已经做完了。
  }
}

function main() {
  const reportPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_REPORT;
  const result = evaluate(reportPath);

  console.log('── 真实站点证据守门 ──');
  console.log(result.reason);
  if (result.lines.length) {
    console.log('');
    for (const l of result.lines) console.log(l);
  }

  const summary = [
    '## 真实站点冒烟（每日体检）',
    '',
    result.ok ? '**结论：测到了东西 ✅**' : '**结论：没测到东西 ❌**',
    '',
    result.reason,
    '',
    ...(result.lines.length ? ['| 站点 | 结果 |', '|---|---|', ...result.lines] : []),
    '',
  ].join('\n');
  writeStepSummary(summary);

  if (!result.ok) {
    console.error('\n❌ 证据守门不通过 —— 这次体检没有证明任何事。');
    process.exit(1);
  }

  if (result.tested < result.total) {
    console.warn(
      `\n⚠️ 部分覆盖：只测到 ${result.tested}/${result.total} 个站点（不算失败，但要看）。`,
    );
  }
  console.log('\n✅ 证据守门通过。');
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${resolve(process.argv[1])}`;

if (isMain) main();
