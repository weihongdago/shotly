/**
 * 真实站点证据守门：**「全绿」不等于「测过了」**。
 *
 * ## 背景
 *
 * `real-sites.yml` 是**不阻塞合并**的定时 workflow（每天跑一次真实站点冒烟）。
 * spec 对「网络不可达」的站点是 `test.skip(...)`，
 * 而 Playwright 里**全部用例被 skip 时 exit code 仍是 0** →
 * 6 个站点全挂 → workflow 绿 → artifact 照样上传。
 *
 * 这个 workflow 的全部价值就是「每天证明 Shotly 在真实网站上还活着」。
 * 全跳过时的绿灯会让人得出「Shotly 在真实网站上没问题」——
 * 而这个结论可能**一个站点都没测**换来的。
 *
 * 这里验的是 `tools/check-real-sites-evidence.mjs` 的判定逻辑。
 * ⚠️ 重点是**它真的会失败** —— 一个永远返回 0 的守门等于没有守门。
 */

import { test, expect, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const CHECKER = resolve(ROOT, 'tools', 'check-real-sites-evidence.mjs');

interface SiteReport {
  id: string;
  label: string;
  url: string;
  status: string;
  pageHeight: number;
  byteSize: number;
  error?: string | null;
  networkUnreachable?: boolean;
}

/**
 * 跑一次守门，返回退出码 + 输出。
 * @param {SiteReport[] | string} content 报告内容（数组）或直接写文件的内容
 */
function runChecker(content: SiteReport[] | string, opts: { raw?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shotly-evidence-'));
  const file = join(dir, 'real-sites-report.json');
  try {
    writeFileSync(file, opts.raw ? (content as string) : JSON.stringify(content), 'utf-8');
    try {
      const stdout = execFileSync('node', [CHECKER, file], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, REAL_SITES_MIN_TESTED: '1' },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        code: e.status ?? -1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function site(over: Partial<SiteReport> = {}): SiteReport {
  return {
    id: 'x',
    label: '示例站点',
    url: 'https://example.com',
    status: 'done',
    pageHeight: 8_000,
    byteSize: 200_000,
    ...over,
  };
}

describe('真实站点证据守门', () => {
  test('守门脚本存在', () => {
    expect(execFileSync('test', ['-f', CHECKER], { encoding: 'utf8' })).toBeDefined();
  });

  test('有站点真的测了 → 通过', () => {
    const r = runChecker([site({ id: 'a' }), site({ id: 'b', status: 'too-long' })]);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('实测 2/2');
  });

  test('全部网络不可达 → 失败（这是「没测」，不是「测过了」）', () => {
    const r = runChecker([
      site({ id: 'a', status: 'network-unreachable', networkUnreachable: true }),
      site({ id: 'b', status: 'network-unreachable', networkUnreachable: true }),
    ]);
    expect(r.code, '全跳过必须是红的').not.toBe(0);
    expect(r.stderr + r.stdout).toContain('网络问题');
  });

  test('报告文件不存在 → 失败', () => {
    const missing = join(tmpdir(), `shotly-evidence-missing-${Date.now()}.json`);
    let code = 0;
    let output = '';
    try {
      execFileSync('node', [CHECKER, missing], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? -1;
      output = (e.stdout ?? '') + (e.stderr ?? '');
    }
    expect(code, '没有报告 = 没测到 = 必须红').not.toBe(0);
    expect(output).toContain('找不到真实站点报告');
  });

  test('报告是空数组 → 失败', () => {
    const r = runChecker([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('一条记录都没有');
  });

  test('报告不是合法 JSON → 失败', () => {
    const r = runChecker('{ not json', { raw: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('不是合法 JSON');
  });

  test('部分网络不可达 + 至少 1 个测到 → 通过，但 summary 要写明覆盖数', () => {
    const r = runChecker([
      site({ id: 'a' }),
      site({ id: 'b', status: 'network-unreachable', networkUnreachable: true }),
    ]);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('实测 1/2');
  });

  test('networkUnreachable=true 但 status=done → 仍然算「没测」', () => {
    // ⚠️ 变异测试：只认 status 的话，这条会被算成「测过了」，
    //    守门就变成绿的 —— 「守门是绿的」不等于「守门在测对的东西」。
    const r = runChecker([site({ status: 'done', networkUnreachable: true })]);
    expect(r.code, '标记了网络不可达就不算测到').not.toBe(0);
  });

  test('status=network-unreachable 但没设 networkUnreachable 字段 → 仍算「没测」', () => {
    // ⚠️ 变异测试：只认 networkUnreachable 字段的话，这条会被算成「测过了」。
    const r = runChecker([site({ status: 'network-unreachable' })]);
    expect(r.code).not.toBe(0);
  });

  test('too-long 算「测到了」（正确拒绝也是产品的真实结论）', () => {
    const r = runChecker([site({ status: 'too-long', error: '页面太长 —— 建议改用区域截图' })]);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('实测 1/1');
  });

  test('状态异常（既不是 done 也不是网络不可达）→ 失败', () => {
    const r = runChecker([site({ status: 'error', error: 'boom' })]);
    expect(r.code).not.toBe(0);
  });
});
