/**
 * @vitest-environment node
 *
 * History store unit tests (architecture v1.2 §6.2).
 *
 * `fake-indexeddb` provides an in-memory IndexedDB. The Node environment is
 * used on purpose: happy-dom's `Blob` keeps its bytes behind a Symbol, and
 * `structuredClone` (used by fake-indexeddb when it stores a record) drops
 * symbol-keyed state — a real browser Blob round-trips just fine.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HISTORY_DB_NAME,
  HISTORY_MAX_ENTRIES,
  addHistory,
  clearHistory,
  countHistory,
  deleteHistory,
  getHistoryBlob,
  listHistory,
  type HistoryMeta,
} from '../history-store';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeMeta(capturedAt: number, overrides: Partial<HistoryMeta> = {}): HistoryMeta {
  return {
    url: 'https://example.com/article',
    title: `Shot ${capturedAt}`,
    capturedAt,
    width: 1280,
    height: 720,
    format: 'png',
    size: 2048,
    source: 'full',
    ...overrides,
  };
}

function makeBlob(payload: string): Blob {
  return new Blob([payload], { type: 'image/png' });
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Remove the whole database — the module must re-open (and re-create) it. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('delete failed'));
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('history-store', () => {
  beforeEach(async () => {
    // Each test starts from an empty store — no cross-test pollution.
    await clearHistory();
  });

  it('stores an entry and reports the correct count', async () => {
    expect(await countHistory()).toBe(0);

    const entry = await addHistory({ blob: makeBlob('one'), meta: makeMeta(1_000) });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.meta.capturedAt).toBe(1_000);

    expect(await countHistory()).toBe(1);
  });

  it('lists entries newest first', async () => {
    await addHistory({ blob: makeBlob('a'), meta: makeMeta(1_000) });
    await addHistory({ blob: makeBlob('b'), meta: makeMeta(3_000) });
    await addHistory({ blob: makeBlob('c'), meta: makeMeta(2_000) });

    const list = await listHistory();
    expect(list.map((item) => item.meta.capturedAt)).toEqual([3_000, 2_000, 1_000]);
  });

  it('never exposes the blob in listings', async () => {
    await addHistory({ blob: makeBlob('a'), meta: makeMeta(1_000) });

    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect('blob' in list[0]).toBe(false);
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('meta');
  });

  it('honours the limit argument', async () => {
    for (let i = 0; i < 5; i++) {
      await addHistory({ blob: makeBlob(`blob-${i}`), meta: makeMeta(1_000 + i) });
    }
    const list = await listHistory(2);
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.meta.capturedAt)).toEqual([1_004, 1_003]);
  });

  it('returns the stored bytes unchanged', async () => {
    const payload = 'shotly-payload-42';
    const entry = await addHistory({ blob: makeBlob(payload), meta: makeMeta(1_000) });

    const stored = await getHistoryBlob(entry.id);
    if (!stored) throw new Error('expected the blob to be stored');
    expect(stored).toBeInstanceOf(Blob);
    expect(await blobBytes(stored)).toEqual(new TextEncoder().encode(payload));
    expect(stored.type).toBe('image/png');
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getHistoryBlob('does-not-exist')).toBeUndefined();
  });

  it('deletes an entry', async () => {
    const entry = await addHistory({ blob: makeBlob('a'), meta: makeMeta(1_000) });
    await addHistory({ blob: makeBlob('b'), meta: makeMeta(2_000) });

    await deleteHistory(entry.id);
    expect(await countHistory()).toBe(1);
    expect(await getHistoryBlob(entry.id)).toBeUndefined();
  });

  it('does not throw when deleting an unknown id', async () => {
    await expect(deleteHistory('nope')).resolves.toBeUndefined();
    expect(await countHistory()).toBe(0);
  });

  it('clears the whole store', async () => {
    await addHistory({ blob: makeBlob('a'), meta: makeMeta(1_000) });
    await addHistory({ blob: makeBlob('b'), meta: makeMeta(2_000) });

    await clearHistory();
    expect(await countHistory()).toBe(0);
    expect(await listHistory()).toEqual([]);
  });

  it('evicts the oldest entries once the cap is exceeded (LRU)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const entry = await addHistory({ blob: makeBlob(`blob-${i}`), meta: makeMeta(1_000 + i) });
      ids.push(entry.id);
    }

    expect(await countHistory()).toBe(HISTORY_MAX_ENTRIES);

    // The five oldest captures were dropped …
    for (const id of ids.slice(0, 5)) {
      expect(await getHistoryBlob(id)).toBeUndefined();
    }
    // … while the newest 50 are still there.
    for (const id of ids.slice(5)) {
      expect(await getHistoryBlob(id)).toBeInstanceOf(Blob);
    }

    const list = await listHistory();
    expect(list).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(list[0].meta.capturedAt).toBe(1_000 + 54);
    expect(list[list.length - 1].meta.capturedAt).toBe(1_000 + 5);
  });

  it('recreates the schema after the database was deleted', async () => {
    await addHistory({ blob: makeBlob('a'), meta: makeMeta(1_000) });
    await deleteDatabase(HISTORY_DB_NAME);

    expect(await countHistory()).toBe(0);
    await addHistory({ blob: makeBlob('b'), meta: makeMeta(2_000) });
    expect(await countHistory()).toBe(1);
  });
});
