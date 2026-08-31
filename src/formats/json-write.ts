import { FormatError } from './error.js';
import type { Edit, WriteOutcome } from './write.js';

/**
 * JSON is the one format that can be re-serialised without losing anything —
 * it has no comments, no anchors and no styles to preserve. Key order is kept
 * because setting an existing key leaves it where it is, and new keys append.
 */
export function writeJsonLocale(
  content: string,
  file: string,
  _locale: string,
  edits: Edit[],
): WriteOutcome {
  let root: Record<string, unknown> = {};

  if (content.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new FormatError(file, err instanceof Error ? err.message : String(err));
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FormatError(file, 'expected an object at the top level');
    }
    root = parsed as Record<string, unknown>;
  }

  const skipped: Array<{ key: string; reason: string }> = [];

  for (const edit of edits) {
    const path = edit.key.split('.');
    let node = root;
    let blocked: string | null = null;

    for (const [index, segment] of path.entries()) {
      if (index === path.length - 1) {
        const existing = node[segment];
        if (existing !== undefined && typeof existing === 'object' && existing !== null) {
          blocked = `${segment} holds a collection, not a string`;
          break;
        }
        node[segment] = edit.value;
        break;
      }

      const next = node[segment];
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        node[segment] = created;
        node = created;
        continue;
      }
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        blocked = `${segment} already holds a value`;
        break;
      }
      node = next as Record<string, unknown>;
    }

    if (blocked) skipped.push({ key: edit.key, reason: blocked });
  }

  return { content: `${JSON.stringify(root, null, 2)}\n`, skipped };
}
