import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { FormatError } from './formats/error.js';
import { readJsonLocale } from './formats/json.js';
import { readPhpLocale } from './formats/php.js';
import { readPoLocale } from './formats/po.js';
import { readYamlLocale } from './formats/yaml.js';
import {
  DEFAULT_RULES,
  type Config,
  type Leaf,
  type LocaleBundle,
  type ReadTarget,
} from './types.js';
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
  'config/locales',
  'locale',
  'po',
];

/** Formats we can read, longest extension first so stripping is unambiguous. */
const EXTENSIONS = ['.json', '.yaml', '.php', '.yml', '.pot', '.po'];

function readerFor(file: string) {
  if (file.endsWith('.php')) return readPhpLocale;
  if (file.endsWith('.po') || file.endsWith('.pot')) return readPoLocale;
  if (file.endsWith('.yml') || file.endsWith('.yaml')) return readYamlLocale;
  return readJsonLocale;
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
  const target: ReadTarget = {
    skipped: [],
    leaves: new Map<string, Leaf>(),
    containers: new Set<string>(),
    plurals: new Map<string, number>(),
    nplurals: null,
  };
  const files: string[] = [];
  const unreadable: Array<{ file: string; message: string }> = [];
  const isSource = locale === config.sourceLocale;

  /**
   * A malformed file is reported, not thrown. A project with a hundred
   * locales and one bad file should still be checked; refusing to read any
   * of it is how a linter becomes something people stop running.
   */
  const read = (file: string, namespace: string): void => {
    try {
      readerFor(file)(file, namespace, locale, isSource, target);
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      unreadable.push({ file, message: err.message });
    }
  };

  if (config.layout === 'flat') {
    // A locale may be en.json or en.php; both are read when both exist.
    for (const ext of EXTENSIONS) {
      const file = join(config.localesDir, `${locale}${ext}`);
      if (!existsSync(file)) continue;
      files.push(file);
      read(file, '');
    }
    if (files.length === 0) {
      throw new ScanError(`No locale file for "${locale}" in ${config.localesDir}`);
    }
  } else {
    const localeRoot = join(config.localesDir, locale);
    for (const file of collectLocaleFiles(localeRoot).sort()) {
      // lang/en/shop/pricing.php -> "shop.pricing";
      // locale/fr/LC_MESSAGES/messages.po -> "messages", since the gettext
      // directory is layout, not namespace.
      const relativePath = relative(localeRoot, file);
      const namespace = (stripExtension(relativePath) ?? relativePath)
        .split(sep)
        .filter((part) => part !== 'LC_MESSAGES')
        .join('.');
      files.push(file);
      read(file, namespace);
    }
  }

  return {
    locale,
    files,
    skipped: target.skipped,
    unreadable,
    leaves: target.leaves,
    containers: target.containers,
    plurals: target.plurals,
    nplurals: target.nplurals,
  };
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
  // but in a PHP project it is the interpolation syntax actually in use — and
  // Laravel keeps string-keyed translations in JSON, so the file extension
  // alone is not the signal. A composer.json or a lang/ directory is.
  const syntaxes = [...DEFAULT_SYNTAXES];
  if (usesLaravelPlaceholders(resolvedRoot, localesDir, layout, locales)) syntaxes.push('laravel');

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

/**
 * Whether this project interpolates the PHP way.
 *
 * Tying it to the .php extension missed every Laravel app that keeps its
 * string-keyed translations in lang/xx.json — which is Laravel's own
 * convention, so the placeholders went unchecked in exactly the projects the
 * syntax exists for.
 */
function usesLaravelPlaceholders(
  root: string,
  localesDir: string,
  layout: 'flat' | 'nested',
  locales: string[],
): boolean {
  if (hasPhpLocales(localesDir, layout, locales)) return true;
  if (existsSync(join(root, 'composer.json'))) return true;
  return basename(localesDir) === 'lang';
}
