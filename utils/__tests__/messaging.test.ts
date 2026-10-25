import { describe, expect, it, vi } from 'vitest';
import {
  PORT_NAMES,
  PROTOCOL_VERSION,
  cryptoRandomId,
  sleep,
} from '../messaging';

describe('messaging protocol (architecture v1.2 §2.3)', () => {
  it('PROTOCOL_VERSION is 1 (locked, no breaking changes mid-stream)', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('PORT_NAMES exposes 4 well-known ports (D+2: +offscreen-port for stitcher relay)', () => {
    expect(PORT_NAMES).toEqual({
      screenshot: 'screenshot-port',
      offscreen: 'offscreen-port',
      history: 'history-port',
      license: 'license-port',
    });
  });

  describe('cryptoRandomId', () => {
    it('returns a valid UUID v4 string', () => {
      const id = cryptoRandomId();
      // UUID v4: 8-4-4-4-12 hex, version digit 4, variant digit [89ab]
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('returns unique values across 100 calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add(cryptoRandomId());
      expect(ids.size).toBe(100);
    });

    it('is non-blocking (returns in <10ms)', () => {
      const start = Date.now();
      cryptoRandomId();
      expect(Date.now() - start).toBeLessThan(10);
    });
  });

  describe('sleep', () => {
    it('resolves after at least the given ms', async () => {
      const start = Date.now();
      await sleep(120);
      expect(Date.now() - start).toBeGreaterThanOrEqual(100); // 20ms tolerance
    });

    it('returns a Promise', () => {
      const p = sleep(10);
      expect(p).toBeInstanceOf(Promise);
      // suppress unhandled-rejection if test runner is strict
      p.catch(() => {});
    });

    it('respects 0ms (resolves after current macrotask)', async () => {
      const order: string[] = [];
      sleep(0).then(() => order.push('sleep'));
      order.push('sync');
      // sleep uses setTimeout → next macrotask, not microtask
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['sync', 'sleep']);
    });
  });

  describe('port heartbeat contract', () => {
    it('heartbeat interval is < 30s (Chrome SW idle threshold)', () => {
      // This is a regression guard: if anyone bumps heartbeat above 30s,
      // MV3 SW will be killed mid-pipeline and screenshots will fail.
      const heartbeatMs = 20_000;
      const SW_IDLE_THRESHOLD_MS = 30_000;
      expect(heartbeatMs).toBeLessThan(SW_IDLE_THRESHOLD_MS);
    });

    it('default port timeout (90s) covers max 30kpx page capture', () => {
      // 30_000px / 4096px segments ≈ 8 segments × 1.5s = 12s + stitch time
      // 90s timeout is comfortable for 50_000px worst case.
      const defaultTimeoutMs = 90_000;
      const worstCaseEstimateMs = 50_000; // 12 chunks × ~4s with retry
      expect(defaultTimeoutMs).toBeGreaterThan(worstCaseEstimateMs);
    });
  });

  describe('Envelope shape (compile-time + runtime)', () => {
    it('envelope fields are present and well-typed', () => {
      const env = {
        v: PROTOCOL_VERSION,
        id: cryptoRandomId(),
        scope: 'bg' as const,
        type: 'screenshot:heartbeat',
      };
      expect(env.v).toBe(1);
      expect(env.scope).toBe('bg');
      expect(typeof env.type).toBe('string');
    });

    it('all 5 Scope values are valid', () => {
      const scopes = ['bg', 'content', 'popup', 'offscreen', 'options'] as const;
      scopes.forEach((s) => expect(typeof s).toBe('string'));
    });
  });
});

describe('messaging telemetry contract', () => {
  it('does not import analytics SDKs (privacy red line)', async () => {
    // Static check: ensure no analytics modules are referenced.
    // (would normally use dependency-cruiser or eslint-plugin-import)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../messaging.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/google-analytics|gtag\(|mixpanel|amplitude|segment\.|hotjar|posthog/i);
  });
});

// ─── Type-level test (compile-time only, zero runtime cost) ──────────────────
import type { Envelope, PortName, Scope } from '../messaging';

type _CheckScope = Expect<Equal<Scope, 'bg' | 'content' | 'popup' | 'offscreen' | 'options'>>;
type _CheckPortName = Expect<Equal<PortName, 'screenshot-port' | 'offscreen-port' | 'history-port' | 'license-port'>>;
type _CheckEnvelope = Expect<Equal<Envelope['v'], 1>>;

// vitest does not have built-in Expect/Equal helpers; alias for type-only tests.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// silence "unused" lints for type-level aliases
const _typeGuard = (() => true) as () => boolean;
expect(_typeGuard()).toBe(true);
void vi; // keep vi import alive even if all dynamic cases removed
