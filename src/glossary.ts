import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const GLOSSARY_FILE = '.i18n/glossary.json';

export type MatchMode = 'prefix' | 'exact' | 'substring';

export interface GlossaryTerm {
  /** The word as it appears in the source locale. */
  source: string;
  /** Accepted renderings per locale. Locales left out are not checked. */
  targets: Record<string, string[]>;
  /** Default `prefix`, which tolerates suffix inflection: panier → paniers. */
  match: MatchMode;
  caseSensitive: boolean;
}

export interface Glossary {
  version: 1;
  /** Tokens that must survive verbatim: brand and product names, protocols. */
  doNotTranslate: string[];
  terms: GlossaryTerm[];
}

export class GlossaryError extends Error {}

export function glossaryPath(root: string, explicit?: string): string {
  return resolve(root, explicit ?? GLOSSARY_FILE);
}

function fail(file: string, message: string): never {
  throw new GlossaryError(`Invalid glossary ${file}\n  ${message}`);
}

function asStringArray(file: string, value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(file, `${where} must be an array of strings`);
  }
  return value as string[];
}

export function loadGlossary(file: string): Glossary | null {
  if (!existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(file, err instanceof Error ? err.message : String(err));
  }

  if (typeof parsed !== 'object' || parsed === null) fail(file, 'expected an object');
  const raw = parsed as Record<string, unknown>;
  if (raw['version'] !== 1) fail(file, 'expected "version": 1');

  const doNotTranslate =
    raw['doNotTranslate'] === undefined
      ? []
      : asStringArray(file, raw['doNotTranslate'], 'doNotTranslate');

  const termsRaw = raw['terms'] === undefined ? [] : raw['terms'];
  if (!Array.isArray(termsRaw)) fail(file, 'terms must be an array');

  const terms: GlossaryTerm[] = termsRaw.map((entry, index) => {
    const where = `terms[${index}]`;
    if (typeof entry !== 'object' || entry === null) fail(file, `${where} must be an object`);
    const term = entry as Record<string, unknown>;

    const source = term['source'];
    if (typeof source !== 'string' || source === '') {
      fail(file, `${where}.source must be a non-empty string`);
    }

    const targetsRaw = term['targets'];
    if (typeof targetsRaw !== 'object' || targetsRaw === null || Array.isArray(targetsRaw)) {
      fail(file, `${where}.targets must be an object keyed by locale`);
    }
    const targets: Record<string, string[]> = {};
    for (const [locale, value] of Object.entries(targetsRaw as Record<string, unknown>)) {
      const forms = asStringArray(file, value, `${where}.targets.${locale}`);
      if (forms.length === 0) fail(file, `${where}.targets.${locale} must list at least one form`);
      targets[locale] = forms;
    }

    const match = term['match'] ?? 'prefix';
    if (match !== 'prefix' && match !== 'exact' && match !== 'substring') {
      fail(file, `${where}.match must be "prefix", "exact" or "substring"`);
    }

    const caseSensitive = term['caseSensitive'] ?? false;
    if (typeof caseSensitive !== 'boolean') fail(file, `${where}.caseSensitive must be a boolean`);

    return { source, targets, match, caseSensitive };
  });

  return { version: 1, doNotTranslate, terms };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * Scripts written without spaces, where a term is normally surrounded by other
 * letters and boundary checks would never match.
 */
const NO_WORD_BREAKS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function usesWordBoundaries(term: string): boolean {
  return !NO_WORD_BREAKS.test(term);
}

/**
 * Whether `term` occurs in `text`.
 *
 * `prefix` is the default because suffix inflection is the common case: a
 * glossary saying "panier" should accept "paniers", and one saying "корзин"
 * should accept every case ending.
 */
export function containsTerm(
  text: string,
  term: string,
  match: MatchMode = 'prefix',
  caseSensitive = false,
): boolean {
  if (term === '') return false;

  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();

  if (match === 'substring' || !usesWordBoundaries(term)) {
    return haystack.includes(needle);
  }

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;

    const before = at === 0 ? '' : haystack[at - 1]!;
    const startsWord = before === '' || !WORDLIKE.test(before);

    if (startsWord) {
      if (match === 'prefix') return true;
      const afterIndex = at + needle.length;
      const after = afterIndex >= haystack.length ? '' : haystack[afterIndex]!;
      if (after === '' || !WORDLIKE.test(after)) return true;
    }

    from = at + 1;
  }
}

export interface TermExpectation {
  term: GlossaryTerm;
  accepted: string[];
}

/** Terms that apply to this source string for this locale, with their forms. */
export function expectationsFor(
  glossary: Glossary,
  locale: string,
  sourceValue: string,
): TermExpectation[] {
  const out: TermExpectation[] = [];
  for (const term of glossary.terms) {
    const accepted = term.targets[locale];
    if (!accepted) continue;
    if (!containsTerm(sourceValue, term.source, term.match, term.caseSensitive)) continue;
    out.push({ term, accepted });
  }
  return out;
}

/** Do-not-translate tokens present in the source but missing from the target. */
export function missingVerbatim(
  glossary: Glossary,
  sourceValue: string,
  targetValue: string,
): string[] {
  const missing: string[] = [];
  for (const token of glossary.doNotTranslate) {
    // Brand names carry their capitalisation, so this comparison is exact.
    if (!containsTerm(sourceValue, token, 'exact', true)) continue;
    if (!containsTerm(targetValue, token, 'exact', true)) missing.push(token);
  }
  return missing;
}
