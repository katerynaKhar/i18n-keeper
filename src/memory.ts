import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadBundle } from './scan.js';
import type { Config } from './types.js';

export const MEMORY_FILE = '.i18n/memory.json';

export interface MemoryEntry {
  /** Hash of the source string at the moment this translation was recorded. */
  sourceHash: string;
  value: string;
  origin: 'human' | 'machine';
  reviewed: boolean;
  updatedAt: string;
}

export interface Memory {
  version: 1;
  sourceLocale: string;
  /** locale -> key -> entry. Nested rather than a flat list, for readable diffs. */
  entries: Record<string, Record<string, MemoryEntry>>;
}

export class MemoryError extends Error {}

/** 48 bits is plenty to notice an edited string, and keeps the file readable. */
export function hashValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export function memoryPath(root: string, explicit?: string): string {
  return resolve(root, explicit ?? MEMORY_FILE);
}

export function emptyMemory(sourceLocale: string): Memory {
  return { version: 1, sourceLocale, entries: {} };
}

export function loadMemory(file: string): Memory | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new MemoryError(
      `Invalid memory file ${file}\n  ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const memory = parsed as Partial<Memory>;
  if (memory?.version !== 1 || typeof memory.entries !== 'object' || memory.entries === null) {
    throw new MemoryError(`Unrecognised memory file format in ${file} (expected version 1)`);
  }
  return { version: 1, sourceLocale: memory.sourceLocale ?? '', entries: memory.entries };
}

/** Writes with sorted keys so the file diffs cleanly in review. */
export function saveMemory(file: string, memory: Memory): void {
  const entries: Record<string, Record<string, MemoryEntry>> = {};
  for (const locale of Object.keys(memory.entries).sort()) {
    const byKey = memory.entries[locale] ?? {};
    const sorted: Record<string, MemoryEntry> = {};
    for (const key of Object.keys(byKey).sort()) sorted[key] = byKey[key]!;
    entries[locale] = sorted;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ version: 1, sourceLocale: memory.sourceLocale, entries }, null, 2)}\n`,
  );
}

export interface StaleVerdict {
  stale: boolean;
  tracked: boolean;
}

/**
 * A translation is stale when the source moved and the translation demonstrably
 * did not. If the target no longer matches what was recorded, someone edited it
 * by hand — we cannot claim it is outdated, so we stay quiet.
 */
export function judge(
  entry: MemoryEntry | undefined,
  sourceValue: string,
  targetValue: string,
): StaleVerdict {
  if (!entry) return { stale: false, tracked: false };
  const moved = entry.sourceHash !== hashValue(sourceValue);
  return { stale: moved && entry.value === targetValue, tracked: true };
}

export interface SyncOptions {
  origin: 'human' | 'machine';
  reviewed: boolean;
  locales?: string[];
  /** Accept the current state wholesale, clearing stale flags. */
  force: boolean;
}

export interface SyncResult {
  created: number;
  updated: number;
  keptStale: number;
  unchanged: number;
  removed: number;
}

/**
 * Records the current translations. Without --force this never clears a stale
 * flag: an entry whose target is unchanged keeps its old source hash, because
 * nothing about the translation has actually been redone.
 */
export function syncMemory(config: Config, memory: Memory, opts: SyncOptions): SyncResult {
  const source = loadBundle(config, config.sourceLocale);
  const result: SyncResult = { created: 0, updated: 0, keptStale: 0, unchanged: 0, removed: 0 };
  const now = new Date().toISOString();
  const wanted = opts.locales && opts.locales.length > 0 ? new Set(opts.locales) : null;

  memory.sourceLocale = config.sourceLocale;

  for (const locale of config.locales) {
    if (locale === config.sourceLocale) continue;
    if (wanted && !wanted.has(locale)) continue;

    const target = loadBundle(config, locale);
    const byKey = (memory.entries[locale] ??= {});

    for (const [key, sourceLeaf] of source.leaves) {
      const targetLeaf = target.leaves.get(key);
      if (!targetLeaf || targetLeaf.value.trim() === '') continue;

      const entry = byKey[key];
      const sourceHash = hashValue(sourceLeaf.value);

      if (!entry) {
        byKey[key] = {
          sourceHash,
          value: targetLeaf.value,
          origin: opts.origin,
          reviewed: opts.reviewed,
          updatedAt: now,
        };
        result.created++;
        continue;
      }

      const translationChanged = entry.value !== targetLeaf.value;

      if (translationChanged || opts.force) {
        if (entry.sourceHash === sourceHash && !translationChanged) {
          result.unchanged++;
          continue;
        }
        byKey[key] = {
          sourceHash,
          value: targetLeaf.value,
          origin: translationChanged ? opts.origin : entry.origin,
          reviewed: translationChanged ? opts.reviewed : entry.reviewed,
          updatedAt: now,
        };
        result.updated++;
        continue;
      }

      if (entry.sourceHash !== sourceHash) result.keptStale++;
      else result.unchanged++;
    }

    // Drop bookkeeping for keys that no longer exist in the source.
    for (const key of Object.keys(byKey)) {
      if (!source.leaves.has(key)) {
        delete byKey[key];
        result.removed++;
      }
    }
  }

  return result;
}
