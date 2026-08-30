import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readJsonLocale } from './formats/json.js';
import { DEFAULT_RULES, type Config, type Leaf, type LocaleBundle } from './types.js';
import { DEFAULT_SYNTAXES } from './placeholders.js';

const CANDIDATE_DIRS = [
  'locales',
  'src/locales',
  'public/locales',
  'app/locales',
  'i18n',
  'src/i18n',
  'lang',
  'translations',
  'src/translations',
];

const LOCALE_CODE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

export class ScanError extends Error {}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Finds the directory holding locale files, or throws with the paths it tried. */
export function findLocalesDir(root: string, explicit?: string): string {
  if (explicit) {
    const dir = resolve(root, explicit);
    if (!isDir(dir)) throw new ScanError(`Locales directory not found: ${dir}`);
    return dir;
  }
  for (const candidate of CANDIDATE_DIRS) {
    const dir = resolve(root, candidate);
    if (isDir(dir) && listLocales(dir).locales.length > 0) return dir;
  }
  throw new ScanError(
    `No locales directory found under ${root}.\nTried: ${CANDIDATE_DIRS.join(', ')}\nPass one explicitly with --locales <path>.`,
  );
}

export interface LocaleLayout {
  layout: 'flat' | 'nested';
  locales: string[];
}

/** `locales/en.json` is flat; `locales/en/common.json` is nested. */
export function listLocales(dir: string): LocaleLayout {
  const entries = readdirSync(dir, { withFileTypes: true });

  const nested = entries
    .filter((e) => e.isDirectory() && LOCALE_CODE.test(e.name))
    .map((e) => e.name);
  if (nested.length > 0) return { layout: 'nested', locales: nested.sort() };

  const flat = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .filter((name) => LOCALE_CODE.test(name));
  return { layout: 'flat', locales: flat.sort() };
}

function collectJsonFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectJsonFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

export function loadBundle(config: Config, locale: string): LocaleBundle {
  const leaves = new Map<string, Leaf>();
  const containers = new Set<string>();
  const files: string[] = [];

  if (config.layout === 'flat') {
    const file = join(config.localesDir, `${locale}.json`);
    files.push(file);
    readJsonLocale(file, '', leaves, containers);
  } else {
    const localeRoot = join(config.localesDir, locale);
    for (const file of collectJsonFiles(localeRoot).sort()) {
      // locales/en/nav/main.json -> namespace "nav.main"
      const namespace = relative(localeRoot, file)
        .slice(0, -'.json'.length)
        .split(sep)
        .join('.');
      files.push(file);
      readJsonLocale(file, namespace, leaves, containers);
    }
  }

  return { locale, files, leaves, containers };
}

export interface DetectOptions {
  localesDir?: string;
  sourceLocale?: string;
}

export function detectProject(root: string, opts: DetectOptions = {}): Config {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) throw new ScanError(`Path not found: ${resolvedRoot}`);

  const localesDir = findLocalesDir(resolvedRoot, opts.localesDir);
  const { layout, locales } = listLocales(localesDir);

  if (locales.length === 0) throw new ScanError(`No locale files in ${localesDir}`);

  let sourceLocale = opts.sourceLocale ?? '';
  if (sourceLocale && !locales.includes(sourceLocale)) {
    throw new ScanError(`Source locale "${sourceLocale}" not among: ${locales.join(', ')}`);
  }
  if (!sourceLocale) {
    // Prefer English, otherwise the most complete locale.
    sourceLocale =
      locales.find((l) => l === 'en') ??
      locales.find((l) => l.startsWith('en')) ??
      locales[0]!;
  }

  return {
    root: resolvedRoot,
    localesDir,
    sourceLocale,
    locales,
    layout,
    placeholderSyntaxes: [...DEFAULT_SYNTAXES],
    ignoreIdentical: [],
    rules: { ...DEFAULT_RULES },
  };
}
