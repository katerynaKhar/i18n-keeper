import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Config, LocaleBundle } from './types.js';
import type { Proposal } from './translate.js';

/**
 * Writing back is deliberately narrower than reading. JSON round-trips without
 * losing anything; PHP, YAML and .po carry comments, anchors and translator
 * notes that a naive re-serialise would silently discard, so those are reported
 * rather than rewritten until each has a real printer.
 */

export class ApplyError extends Error {}

export interface Destination {
  file: string;
  /** Path inside the file, with any file-level namespace already removed. */
  path: string[];
}

function namespaceOf(config: Config, sourceFile: string): string {
  const localeRoot = join(config.localesDir, config.sourceLocale);
  const relativePath = relative(localeRoot, sourceFile).replace(/\.[^.]+$/, '');
  return relativePath
    .split(sep)
    .filter((part) => part !== 'LC_MESSAGES')
    .join('.');
}

/** Where a translation for `key` belongs, or null when the format cannot be written. */
export function destinationFor(
  config: Config,
  source: LocaleBundle,
  locale: string,
  key: string,
): Destination | null {
  if (config.layout === 'flat') {
    const file = join(config.localesDir, `${locale}.json`);
    if (!existsSync(file) && !existsSync(join(config.localesDir, `${config.sourceLocale}.json`))) {
      return null;
    }
    return { file, path: key.split('.') };
  }

  const sourceLeaf = source.leaves.get(key);
  if (!sourceLeaf || !sourceLeaf.file.endsWith('.json')) return null;

  const localeRoot = join(config.localesDir, config.sourceLocale);
  const withinLocale = relative(localeRoot, sourceLeaf.file);
  const namespace = namespaceOf(config, sourceLeaf.file);
  const inner = namespace && key.startsWith(`${namespace}.`) ? key.slice(namespace.length + 1) : key;

  return { file: join(config.localesDir, locale, withinLocale), path: inner.split('.') };
}

function setPath(root: Record<string, unknown>, path: string[], value: string, file: string): void {
  let node: Record<string, unknown> = root;
  for (const [index, segment] of path.entries()) {
    if (index === path.length - 1) {
      node[segment] = value;
      return;
    }
    const next = node[segment];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
      continue;
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new ApplyError(
        `Cannot write ${path.join('.')} in ${file}: ${segment} already holds a value`,
      );
    }
    node = next as Record<string, unknown>;
  }
}

export interface ApplyResult {
  written: number;
  files: string[];
  /** Keys whose format has no writer yet. */
  skipped: Array<{ locale: string; key: string; reason: string }>;
}

export function applyProposals(
  config: Config,
  source: LocaleBundle,
  proposals: Proposal[],
): ApplyResult {
  const result: ApplyResult = { written: 0, files: [], skipped: [] };
  const byFile = new Map<string, Array<{ path: string[]; value: string }>>();

  for (const proposal of proposals) {
    if (!proposal.accepted) continue;

    const destination = destinationFor(config, source, proposal.locale, proposal.key);
    if (!destination) {
      result.skipped.push({
        locale: proposal.locale,
        key: proposal.key,
        reason: 'no writer for this format yet',
      });
      continue;
    }

    const list = byFile.get(destination.file);
    if (list) list.push({ path: destination.path, value: proposal.value });
    else byFile.set(destination.file, [{ path: destination.path, value: proposal.value }]);
  }

  for (const [file, edits] of byFile) {
    let root: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new ApplyError(`Cannot write ${file}: it does not hold an object`);
        }
        root = parsed as Record<string, unknown>;
      } catch (err) {
        if (err instanceof ApplyError) throw err;
        throw new ApplyError(
          `Cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const edit of edits) setPath(root, edit.path, edit.value, file);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
    result.files.push(file);
    result.written += edits.length;
  }

  return result;
}
