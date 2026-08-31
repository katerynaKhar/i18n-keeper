import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Glossary } from './glossary.js';
import { limitFor, type Limits } from './lengths.js';
import { hashValue, type Memory } from './memory.js';
import type { Config, LocaleBundle } from './types.js';
import { writeJsonLocale } from './formats/json-write.js';
import { writePhpLocale } from './formats/php-write.js';
import { writePoLocale } from './formats/po-write.js';
import { writeYamlLocale } from './formats/yaml-write.js';
import type { Edit, LocaleWriter } from './formats/write.js';
import { validate, type Proposal } from './translate.js';

/**
 * Writing back is deliberately narrower than reading. JSON round-trips without
 * losing anything; PHP, YAML and .po carry comments, anchors and translator
 * notes that a naive re-serialise would silently discard, so those are reported
 * rather than rewritten until each has a real printer.
 */

export class ApplyError extends Error {}

export interface Destination {
  file: string;
  /** The key as that file spells it, with any file-level namespace removed. */
  key: string;
}

const WRITERS = new Map<string, LocaleWriter>([
  ['.json', writeJsonLocale],
  ['.php', writePhpLocale],
  ['.yaml', writeYamlLocale],
  ['.yml', writeYamlLocale],
  ['.pot', writePoLocale],
  ['.po', writePoLocale],
]);

/**
 * Formats whose empty form is unambiguous, so a locale file that does not exist
 * yet can be created. A YAML file's shape depends on whether the project nests
 * under a locale root, and a gettext catalogue needs a header declaring its own
 * plural rules — neither can be invented, so those must already exist.
 */
const CREATABLE = new Map<string, string>([
  ['.json', '{}\n'],
  ['.php', '<?php\n\nreturn [\n];\n'],
]);

function extensionOf(file: string): string {
  const at = file.lastIndexOf('.');
  return at === -1 ? '' : file.slice(at).toLowerCase();
}

function namespaceOf(config: Config, sourceFile: string): string {
  const localeRoot = join(config.localesDir, config.sourceLocale);
  return relative(localeRoot, sourceFile)
    .replace(/\.[^.]+$/, '')
    .split(sep)
    .filter((part) => part !== 'LC_MESSAGES')
    .join('.');
}

/**
 * Which source file a key belongs to.
 *
 * Not every key the target needs exists in the source: a plural form only the
 * target language has — Polish `items.few` against English `one`/`other` — has
 * no source leaf at all. Such a key still belongs wherever its neighbours live,
 * so the lookup walks up to the nearest prefix that does exist.
 */
function sourceFileFor(source: LocaleBundle, key: string): string | null {
  const leaf = source.leaves.get(key);
  if (leaf) return leaf.file;

  const parts = key.split('.');
  for (let depth = parts.length - 1; depth > 0; depth--) {
    const prefix = `${parts.slice(0, depth).join('.')}.`;
    for (const [candidate, candidateLeaf] of source.leaves) {
      if (candidate.startsWith(prefix)) return candidateLeaf.file;
    }
  }

  // i18next spells plurals as item_few rather than item.few.
  const underscore = key.lastIndexOf('_');
  if (underscore > 0) {
    const base = `${key.slice(0, underscore)}_`;
    for (const [candidate, candidateLeaf] of source.leaves) {
      if (candidate.startsWith(base)) return candidateLeaf.file;
    }
  }

  return source.files[0] ?? null;
}

/** Where a translation for `key` belongs, or null when the format is unknown. */
export function destinationFor(
  config: Config,
  source: LocaleBundle,
  locale: string,
  key: string,
): Destination | null {
  const from = sourceFileFor(source, key);
  if (!from) return null;

  const extension = extensionOf(from);
  if (!WRITERS.has(extension)) return null;

  if (config.layout === 'flat') {
    return { file: join(config.localesDir, `${locale}${extension}`), key };
  }

  const localeRoot = join(config.localesDir, config.sourceLocale);
  const withinLocale = relative(localeRoot, from);
  const namespace = namespaceOf(config, from);
  const inner = namespace && key.startsWith(`${namespace}.`) ? key.slice(namespace.length + 1) : key;

  return { file: join(config.localesDir, locale, withinLocale), key: inner };
}

export interface ApplyResult {
  written: number;
  files: string[];
  /** Translations that could not be written, and why. */
  skipped: Array<{ locale: string; key: string; reason: string }>;
}

export function applyProposals(
  config: Config,
  source: LocaleBundle,
  proposals: Proposal[],
): ApplyResult {
  const result: ApplyResult = { written: 0, files: [], skipped: [] };
  const byFile = new Map<string, { locale: string; edits: Edit[] }>();

  for (const proposal of proposals) {
    if (!proposal.accepted) continue;

    const destination = destinationFor(config, source, proposal.locale, proposal.key);
    if (!destination) {
      result.skipped.push({
        locale: proposal.locale,
        key: proposal.key,
        reason: 'no writer for this format',
      });
      continue;
    }

    const bucket = byFile.get(destination.file);
    const edit: Edit = { key: destination.key, value: proposal.value };
    if (bucket) bucket.edits.push(edit);
    else byFile.set(destination.file, { locale: proposal.locale, edits: [edit] });
  }

  for (const [file, { locale, edits }] of byFile) {
    const extension = extensionOf(file);
    const writer = WRITERS.get(extension)!;

    let content: string;
    if (existsSync(file)) {
      content = readFileSync(file, 'utf8');
    } else {
      const blank = CREATABLE.get(extension);
      if (blank === undefined) {
        for (const edit of edits) {
          result.skipped.push({
            locale,
            key: edit.key,
            reason: `${file} does not exist and this format cannot be created from nothing`,
          });
        }
        continue;
      }
      content = blank;
    }

    let outcome;
    try {
      outcome = writer(content, file, locale, edits);
    } catch (err) {
      throw new ApplyError(
        `Cannot write ${file}\n  ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const skip of outcome.skipped) {
      result.skipped.push({ locale, key: skip.key, reason: skip.reason });
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, outcome.content);
    result.files.push(file);
    result.written += edits.length - outcome.skipped.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Saved runs
// ---------------------------------------------------------------------------

export const SAVE_VERSION = 1;

export interface SavedRun {
  version: number;
  model: string;
  sourceLocale: string;
  createdAt: string;
  aborted: string | null;
  proposals: Proposal[];
}

export function saveRun(file: string, run: SavedRun): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
}

export function loadRun(file: string): SavedRun {
  if (!existsSync(file)) throw new ApplyError(`Proposals file not found: ${file}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ApplyError(
      `Cannot read ${file}\n  ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const run = parsed as Partial<SavedRun> | null;
  if (!run || run.version !== SAVE_VERSION) {
    throw new ApplyError(`Unrecognised proposals file ${file} (expected version ${SAVE_VERSION})`);
  }
  if (!Array.isArray(run.proposals)) throw new ApplyError(`${file} has no proposals array`);

  return {
    version: SAVE_VERSION,
    model: run.model ?? 'unknown',
    sourceLocale: run.sourceLocale ?? '',
    createdAt: run.createdAt ?? '',
    aborted: run.aborted ?? null,
    proposals: run.proposals,
  };
}

export interface Recheck {
  ready: Proposal[];
  dropped: Array<{ proposal: Proposal; reason: string }>;
}

/**
 * The gate runs again at apply time.
 *
 * A saved file can be days old and is editable by hand, so nothing is written
 * on the strength of a check made earlier against files that may since have
 * moved. A proposal whose source string has changed is dropped rather than
 * applied to text it was not written for.
 */
export function recheck(
  config: Config,
  source: LocaleBundle,
  glossary: Glossary | null,
  limits: Limits | null,
  proposals: Proposal[],
): Recheck {
  const ready: Proposal[] = [];
  const dropped: Array<{ proposal: Proposal; reason: string }> = [];

  for (const proposal of proposals) {
    if (!proposal.accepted) {
      dropped.push({ proposal, reason: 'was rejected when proposed' });
      continue;
    }

    const leaf = source.leaves.get(proposal.key);
    if (!leaf) {
      dropped.push({ proposal, reason: 'the key is no longer in the source locale' });
      continue;
    }
    if (leaf.value !== proposal.source) {
      dropped.push({ proposal, reason: 'the source string changed after the proposal was made' });
      continue;
    }

    const problems = validate(
      config,
      {
        source: leaf.value,
        locale: proposal.locale,
        maxWidth: limits ? limitFor(limits, proposal.key) : null,
      },
      proposal.value,
      glossary,
    );
    if (problems.length > 0) {
      dropped.push({ proposal, reason: problems.join('; ') });
      continue;
    }

    ready.push(proposal);
  }

  return { ready, dropped };
}

/** Machine output is recorded unreviewed, whichever command wrote it. */
export function recordMachine(memory: Memory, proposals: Proposal[], now: string): void {
  for (const proposal of proposals) {
    const byKey = (memory.entries[proposal.locale] ??= {});
    byKey[proposal.key] = {
      sourceHash: hashValue(proposal.source),
      value: proposal.value,
      origin: 'machine',
      reviewed: false,
      updatedAt: now,
    };
  }
}
