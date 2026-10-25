/**
 * Screenshot history store (architecture v1.2 §6.2)
 *
 * L2 storage — IndexedDB via `idb`:
 *   db `shotly` v1 → object store `history` (keyPath `id`)
 *   indexes: `capturedAt` (number) + `source` (string), both pointing into `meta`
 *
 * The blob bytes live in the very same record as the metadata, so a single
 * `delete()` drops the payload *and* the secondary index rows inside one
 * transaction — no orphaned screenshots, no stale index entries.
 *
 * Retention (PRD §3.2 F7): keep the newest 50 captures. Once the limit is
 * exceeded the oldest ones (ascending `capturedAt`) are evicted LRU-style.
 *
 * `unlimitedStorage` (architecture §6.4) is what lets 50 full-page PNGs live
 * on disk instead of being squeezed into the ~10MB chrome.storage quota.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const HISTORY_DB_NAME = 'shotly';
export const HISTORY_DB_VERSION = 1;
export const HISTORY_STORE = 'history';
export const HISTORY_MAX_ENTRIES = 50;

export type HistoryFormat = 'png' | 'jpg' | 'pdf';
export type HistorySource = 'full' | 'visible' | 'region' | 'editor';

export interface HistoryMeta {
  url: string;
  title: string;
  capturedAt: number;
  width: number;
  height: number;
  format: HistoryFormat;
  size: number;
  source: HistorySource;
}

export interface HistoryEntry {
  id: string;
  blob: Blob;
  meta: HistoryMeta;
}

/** Listing payload — the blob is fetched on demand via `getHistoryBlob`. */
export type HistoryEntrySummary = Omit<HistoryEntry, 'blob'>;

/** Index names — implementation detail of the store, not part of the API. */
const CAPTURED_AT_INDEX = 'capturedAt';
const SOURCE_INDEX = 'source';

/** IndexedDB schema — mirrors architecture §6.2. */
interface HistoryDbSchema extends DBSchema {
  history: {
    key: string;
    value: HistoryEntry;
    indexes: {
      capturedAt: number;
      source: string;
    };
  };
}

/**
 * Cached connection.
 *
 * Opening a database per call would be wasteful inside the service worker,
 * but a cached handle also has to survive schema upgrades triggered by
 * another context — hence the `versionchange` / `close` listeners below.
 */
let dbPromise: Promise<IDBPDatabase<HistoryDbSchema>> | null = null;
let currentDb: IDBPDatabase<HistoryDbSchema> | null = null;

/**
 * Open (and cache) the history database.
 *
 * Rejects with a contextual error when IndexedDB cannot be opened at all
 * (private mode, corrupted profile, blocked upgrade …).
 */
export function openHistoryDb(): Promise<IDBPDatabase> {
  // The schema typing is an implementation detail — callers only need the
  // raw `idb` handle, so the typed database is widened on the way out.
  return openHistoryDbTyped() as Promise<IDBPDatabase>;
}

/** Typed variant — keeps the store / index types precise for internal use. */
async function openHistoryDbTyped(): Promise<IDBPDatabase<HistoryDbSchema>> {
  if (dbPromise) return dbPromise;

  const pending: Promise<IDBPDatabase<HistoryDbSchema>> = openDB<HistoryDbSchema>(
    HISTORY_DB_NAME,
    HISTORY_DB_VERSION,
    {
      upgrade(database) {
        // The store is created exactly once (at version 1) — a re-open must
        // never wipe the user's history.
        if (database.objectStoreNames.contains(HISTORY_STORE)) return;
        const store = database.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        // Metadata lives under `meta` (architecture §6.2) → nested key paths.
        store.createIndex(CAPTURED_AT_INDEX, 'meta.capturedAt');
        store.createIndex(SOURCE_INDEX, 'meta.source');
      },
    },
  ).catch((err: unknown) => {
    // Never cache a failed connection — the next call must retry.
    dbPromise = null;
    currentDb = null;
    throw new Error(`[shotly:history] open db failed: ${describeError(err)}`);
  });

  dbPromise = pending;
  const db = await pending;

  // Another context wants to change the schema — release our handle so the
  // upgrade is not blocked forever, and drop the cached promise.
  const release = () => {
    if (currentDb === db) {
      currentDb = null;
      dbPromise = null;
    }
  };
  db.addEventListener('versionchange', () => {
    db.close();
    release();
  });
  db.addEventListener('close', release);

  currentDb = db;
  return db;
}

/**
 * Persist a screenshot and evict the oldest entries when the cap is reached.
 *
 * The insert and the LRU eviction share one transaction: a failed eviction can
 * therefore never leave the store above `HISTORY_MAX_ENTRIES`.
 */
export async function addHistory(input: { blob: Blob; meta: HistoryMeta }): Promise<HistoryEntry> {
  const db = await openHistoryDbTyped();
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    blob: input.blob,
    meta: input.meta,
  };

  const tx = db.transaction(HISTORY_STORE, 'readwrite');
  try {
    await tx.store.add(entry);
    const total = await tx.store.count();
    if (total > HISTORY_MAX_ENTRIES) {
      // Ascending `capturedAt` index → the head of the range is the oldest shot.
      const stale = await tx.store
        .index(CAPTURED_AT_INDEX)
        .getAll(null, total - HISTORY_MAX_ENTRIES);
      for (const victim of stale) {
        // Deleting the record removes the blob bytes *and* both index entries
        // inside this transaction — nothing is left dangling.
        await tx.store.delete(victim.id);
      }
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Transaction already finished — nothing to roll back.
    }
    throw new Error(`[shotly:history] add failed: ${describeError(err)}`);
  }
  return entry;
}

/**
 * List history entries, newest first.
 *
 * The blob is intentionally left out — the popup only needs the metadata, and
 * pulling 50 screenshots into memory would be wasteful.
 */
export async function listHistory(
  limit: number = HISTORY_MAX_ENTRIES,
): Promise<HistoryEntrySummary[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const db = await openHistoryDbTyped();
  const tx = db.transaction(HISTORY_STORE, 'readonly');
  const summaries: HistoryEntrySummary[] = [];
  try {
    // 'prev' walks the `capturedAt` index backwards → newest entry first.
    let cursor = await tx.store.index(CAPTURED_AT_INDEX).openCursor(null, 'prev');
    while (cursor && summaries.length < limit) {
      summaries.push(toSummary(cursor.value));
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch (err) {
    throw new Error(`[shotly:history] list failed: ${describeError(err)}`);
  }
  return summaries;
}

/** Fetch the screenshot bytes of a single entry — `undefined` when unknown. */
export async function getHistoryBlob(id: string): Promise<Blob | undefined> {
  const db = await openHistoryDbTyped();
  try {
    const entry = await db.get(HISTORY_STORE, id);
    return entry?.blob;
  } catch (err) {
    throw new Error(`[shotly:history] get blob failed: ${describeError(err)}`);
  }
}

/** Delete one entry. Unknown ids are a no-op — deleting must never throw. */
export async function deleteHistory(id: string): Promise<void> {
  const db = await openHistoryDbTyped();
  try {
    await db.delete(HISTORY_STORE, id);
  } catch (err) {
    throw new Error(`[shotly:history] delete failed: ${describeError(err)}`);
  }
}

/** Drop the whole history (settings → "clear screenshots"). */
export async function clearHistory(): Promise<void> {
  const db = await openHistoryDbTyped();
  try {
    await db.clear(HISTORY_STORE);
  } catch (err) {
    throw new Error(`[shotly:history] clear failed: ${describeError(err)}`);
  }
}

/** Number of stored entries. */
export async function countHistory(): Promise<number> {
  const db = await openHistoryDbTyped();
  try {
    return await db.count(HISTORY_STORE);
  } catch (err) {
    throw new Error(`[shotly:history] count failed: ${describeError(err)}`);
  }
}

/** Strip the blob — listings must stay lightweight. */
function toSummary(entry: HistoryEntry): HistoryEntrySummary {
  return { id: entry.id, meta: entry.meta };
}

/** Unknown throwables (DOMException, string, …) → readable message. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
