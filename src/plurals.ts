/**
 * CLDR plural categories, taken from the ICU data already in the runtime rather
 * than a hand-maintained table: the table would go stale, and this is the same
 * data the application itself will use at runtime.
 */

export const CATEGORY_NAMES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type Category = (typeof CATEGORY_NAMES)[number];

const CATEGORIES = new Set<string>(CATEGORY_NAMES);
const cache = new Map<string, Set<string> | null>();

export function isCategory(name: string): name is Category {
  return CATEGORIES.has(name);
}

/**
 * Categories CLDR defines for a locale, or null when we cannot tell.
 *
 * Intl.PluralRules silently falls back to the system locale for tags it does
 * not know — asking for "zz" on a Russian machine reports four categories — so
 * a resolved language subtag that does not match the request means "unknown"
 * rather than a wrong answer.
 */
export function categoriesFor(locale: string): Set<string> | null {
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;

  const tag = locale.replace(/_/g, '-');
  let result: Set<string> | null = null;

  try {
    const resolved = new Intl.PluralRules(tag, { type: 'cardinal' }).resolvedOptions();
    const asked = tag.split('-')[0]!.toLowerCase();
    const got = resolved.locale.split('-')[0]!.toLowerCase();
    if (asked === got && resolved.pluralCategories.length > 0) {
      result = new Set(resolved.pluralCategories);
    }
  } catch {
    result = null;
  }

  cache.set(locale, result);
  return result;
}

// ---------------------------------------------------------------------------
// ICU MessageFormat
// ---------------------------------------------------------------------------

export interface PluralBlock {
  arg: string;
  type: 'plural' | 'selectordinal';
  /** Keyword selectors: one, few, other … */
  categories: Set<string>;
  /** Exact selectors: =0, =1 … which are not CLDR categories. */
  exact: Set<string>;
}

export interface IcuScan {
  blocks: PluralBlock[];
  error: string | null;
}

const PLURAL_INTENT = /\{\s*[\w.$-]+\s*,\s*(?:plural|selectordinal)\b/;

/** Whether the string is trying to be an ICU plural at all. */
export function looksLikeIcuPlural(text: string): boolean {
  return PLURAL_INTENT.test(text);
}

class IcuScanner {
  private pos = 0;
  readonly blocks: PluralBlock[] = [];

  constructor(private readonly text: string) {}

  private get done(): boolean {
    return this.pos >= this.text.length;
  }

  private fail(message: string): never {
    throw new Error(`${message} at offset ${this.pos}`);
  }

  private skipWs(): void {
    while (!this.done && /\s/.test(this.text[this.pos]!)) this.pos++;
  }

  private readIdent(): string {
    const start = this.pos;
    while (!this.done && /[\w.$-]/.test(this.text[this.pos]!)) this.pos++;
    return this.text.slice(start, this.pos);
  }

  /** ICU quoting: '{', '}' and '#' start a literal run; '' is one apostrophe. */
  private skipQuote(): void {
    const next = this.text[this.pos + 1];
    if (next === "'") {
      this.pos += 2;
      return;
    }
    if (next === '{' || next === '}' || next === '#') {
      const close = this.text.indexOf("'", this.pos + 1);
      this.pos = close === -1 ? this.text.length : close + 1;
      return;
    }
    this.pos++;
  }

  /** Consumes a message body; with `nested`, stops after the matching brace. */
  private scanMessage(nested: boolean): void {
    while (!this.done) {
      const ch = this.text[this.pos]!;
      if (ch === "'") {
        this.skipQuote();
        continue;
      }
      if (ch === '}') {
        if (!nested) this.fail('Unexpected }');
        this.pos++;
        return;
      }
      if (ch === '{') {
        this.scanArgument();
        continue;
      }
      this.pos++;
    }
    if (nested) this.fail('Unclosed {');
  }

  /** Consumes `{...}` of any argument type, starting at the opening brace. */
  private scanArgument(): void {
    this.pos++; // {
    this.skipWs();
    const name = this.readIdent();
    this.skipWs();

    if (this.done) this.fail('Unclosed {');
    if (this.text[this.pos] === '}') {
      this.pos++;
      return;
    }
    if (this.text[this.pos] !== ',') this.fail('Expected , or } in argument');
    this.pos++;
    this.skipWs();

    const type = this.readIdent();
    this.skipWs();

    if (this.done) this.fail('Unclosed {');
    if (this.text[this.pos] === '}') {
      this.pos++;
      return;
    }
    if (this.text[this.pos] !== ',') this.fail(`Expected , or } after ${type || 'argument type'}`);
    this.pos++;

    if (type === 'plural' || type === 'selectordinal') {
      this.scanPluralBody(name, type);
    } else {
      this.scanOpaqueBody();
    }
  }

  /** For select/number/date: keep the braces balanced, ignore the content. */
  private scanOpaqueBody(): void {
    let depth = 1;
    while (!this.done) {
      const ch = this.text[this.pos]!;
      if (ch === "'") {
        this.skipQuote();
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        this.pos++;
        if (depth === 0) return;
        continue;
      }
      this.pos++;
    }
    this.fail('Unclosed {');
  }

  private scanPluralBody(arg: string, type: 'plural' | 'selectordinal'): void {
    const block: PluralBlock = { arg, type, categories: new Set(), exact: new Set() };

    for (;;) {
      this.skipWs();
      if (this.done) this.fail('Unclosed plural');

      if (this.text[this.pos] === '}') {
        this.pos++;
        break;
      }

      if (this.text.startsWith('offset:', this.pos)) {
        this.pos += 'offset:'.length;
        this.skipWs();
        while (!this.done && /[\d.-]/.test(this.text[this.pos]!)) this.pos++;
        continue;
      }

      if (this.text[this.pos] === '=') {
        this.pos++;
        const start = this.pos;
        while (!this.done && /[\d.]/.test(this.text[this.pos]!)) this.pos++;
        if (this.pos === start) this.fail('Expected a number after =');
        block.exact.add(`=${this.text.slice(start, this.pos)}`);
      } else {
        const keyword = this.readIdent();
        if (!keyword) this.fail('Expected a plural selector');
        block.categories.add(keyword);
      }

      this.skipWs();
      if (this.text[this.pos] !== '{') this.fail('Expected { after a plural selector');
      this.pos++;
      this.scanMessage(true);
    }

    this.blocks.push(block);
  }

  run(): void {
    this.scanMessage(false);
  }
}

export function scanIcu(text: string): IcuScan {
  const scanner = new IcuScanner(text);
  try {
    scanner.run();
    return { blocks: scanner.blocks, error: null };
  } catch (err) {
    return {
      blocks: scanner.blocks,
      // Only meaningful for strings that meant to be ICU; i18next's {{name}}
      // is not ICU and must not be reported as broken ICU.
      error: looksLikeIcuPlural(text) ? (err instanceof Error ? err.message : String(err)) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// i18next suffix keys: item_one, item_few, item_other
// ---------------------------------------------------------------------------

export interface SuffixKey {
  base: string;
  category: Category;
  separator: '_' | '.';
}

export interface PluralGroup {
  categories: Set<Category>;
  /** Kept so a finding can name the keys as the project actually writes them. */
  separator: '_' | '.';
}

/** i18next writes item_one; Rails and Symfony nest it as item.one. */
export function splitPluralSuffix(key: string): SuffixKey | null {
  for (const separator of ['_', '.'] as const) {
    const at = key.lastIndexOf(separator);
    if (at <= 0) continue;
    const suffix = key.slice(at + 1);
    if (isCategory(suffix)) return { base: key.slice(0, at), category: suffix, separator };
  }
  return null;
}

/**
 * Groups keys like item_one / item_other into base -> categories.
 *
 * A group must carry `other`, which every CLDR plural set has. Without that
 * test, Rails' `restrict_dependent_destroy.has_one` / `has_many` — ActiveRecord
 * association names — read as a plural group and were asked to grow the forms
 * their language requires.
 */
export function pluralGroups(keys: Iterable<string>): Map<string, PluralGroup> {
  const groups = new Map<string, PluralGroup>();
  for (const key of keys) {
    const split = splitPluralSuffix(key);
    if (!split) continue;
    let group = groups.get(split.base);
    if (!group) {
      group = { categories: new Set(), separator: split.separator };
      groups.set(split.base, group);
    }
    group.categories.add(split.category);
  }

  for (const [base, group] of groups) {
    if (!group.categories.has('other')) groups.delete(base);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Laravel pipe selection — deliberately not CLDR
// ---------------------------------------------------------------------------

/**
 * Laravel picks a segment by position or by explicit {0} / [1,*] ranges, which
 * is its own mechanism and not CLDR. All we can honestly compare is the segment
 * count, so that is all this reports.
 */
export function pipeSegments(text: string): number {
  let count = 1;
  let depth = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth === 0) count++;
  }
  return count;
}
