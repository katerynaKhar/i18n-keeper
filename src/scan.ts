import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readJsonLocale } from './formats/json.js';
import { readPhpLocale } from './formats/php.js';
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
  'resources/lang',
  'translations',
  'src/translations',
];

/** Formats we can read, longest extension first so stripping is unambiguous. */
const EXTENSIONS = ['.json', '.php'];

function readerFor(file: string) {
  return file.endsWith('.php') ? readPhpLocale : readJsonLocale;
}

function stripExtension(name: string): string | null {
  for (const ext of EXTENSIONS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return null;
}

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
    .filter((e) => e.isFile())
    .map((e) => stripExtension(e.name))
    .filter((name): name is string => name !== null && LOCALE_CODE.test(name));
  return { layout: 'flat', locales: [...new Set(flat)].sort() };
}

function collectLocaleFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectLocaleFiles(full, acc);
    else if (entry.isFile() && stripExtension(entry.name) !== null) acc.push(full);
  }
  return acc;
}

export function loadBundle(config: Config, locale: string): LocaleBundle {
  const leaves = new Map<string, Leaf>();
  const containers = new Set<string>();
  const files: string[] = [];

  if (config.layout === 'flat') {
    // A locale may be en.json or en.php; both are read when both exist.
    for (const ext of EXTENSIONS) {
      const file = join(config.localesDir, `${locale}${ext}`);
      if (!existsSync(file)) continue;
      files.push(file);
      readerFor(file)(file, '', leaves, containers);
    }
    if (files.length === 0) {
      throw new ScanError(`No locale file for "${locale}" in ${config.localesDir}`);
    }
  } else {
    const localeRoot = join(config.localesDir, locale);
    for (const file of collectLocaleFiles(localeRoot).sort()) {
      // lang/en/shop/pricing.php -> namespace "shop.pricing"
      const relativePath = relative(localeRoot, file);
      const namespace = (stripExtension(relativePath) ?? relativePath).split(sep).join('.');
      files.push(file);
      readerFor(file)(file, namespace, leaves, containers);
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

  // Laravel's :name is off by default because it false-positives on prose,
  // but in a PHP project it is the interpolation syntax actually in use.
  const syntaxes = [...DEFAULT_SYNTAXES];
  if (hasPhpLocales(localesDir, layout, locales)) syntaxes.push('laravel');

  return {
    root: resolvedRoot,
    localesDir,
    sourceLocale,
    locales,
    layout,
    placeholderSyntaxes: syntaxes,
    ignoreIdentical: [],
    rules: { ...DEFAULT_RULES },
  };
}

function hasPhpLocales(localesDir: string, layout: 'flat' | 'nested', locales: string[]): boolean {
  if (layout === 'flat') {
    return locales.some((locale) => existsSync(join(localesDir, `${locale}.php`)));
  }
  return locales.some((locale) => {
    const dir = join(localesDir, locale);
    return isDir(dir) && collectLocaleFiles(dir).some((file) => file.endsWith('.php'));
  });
}
