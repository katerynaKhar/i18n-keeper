export type Severity = 'error' | 'warning';
export type RuleSetting = Severity | 'off';

export const RULE_IDS = [
  'missing_key',
  'orphan_key',
  'empty_value',
  'structure_mismatch',
  'placeholder_missing',
  'placeholder_extra',
  'identical_to_source',
  'stale',
  'untracked',
  'icu_syntax_error',
  'plural_missing_category',
  'plural_extra_category',
  'plural_selector_lost',
  'dnt_violation',
  'glossary_violation',
  'inconsistent_translation',
  'length_over_max',
  'length_overflow',
  'unreadable_file',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Default severities. Anything that breaks at runtime is an error. */
export const DEFAULT_RULES: Record<RuleId, RuleSetting> = {
  missing_key: 'error',
  orphan_key: 'warning',
  empty_value: 'error',
  structure_mismatch: 'error',
  placeholder_missing: 'error',
  placeholder_extra: 'error',
  // Correct far more often than not on real data — country names, product
  // names, borrowed words — so it is asked for rather than assumed.
  identical_to_source: 'off',
  stale: 'warning',
  // Every key is untracked until the first sync, so this one is opt-in.
  untracked: 'off',
  // Malformed ICU throws at format time; a missing category only renders the
  // wrong grammar, which is bad but not fatal.
  icu_syntax_error: 'error',
  plural_missing_category: 'warning',
  plural_extra_category: 'warning',
  plural_selector_lost: 'warning',
  dnt_violation: 'warning',
  glossary_violation: 'warning',
  // Reusing one wording for a repeated source string is often deliberate, so
  // this is opt-in rather than noise by default.
  inconsistent_translation: 'off',
  length_over_max: 'warning',
  // Ratio-based and therefore approximate; asked for rather than assumed.
  length_overflow: 'off',
  unreadable_file: 'error',
};

export interface Finding {
  rule: RuleId;
  severity: Severity;
  locale: string;
  key: string;
  detail: string;
  file: string;
}

export type LeafKind = 'string' | 'number' | 'boolean' | 'null';

export interface Leaf {
  value: string;
  kind: LeafKind;
  file: string;
  /** gettext marks a translation whose source moved as fuzzy. */
  fuzzy?: boolean;
}

/** What a format reader fills in while reading one file. */
export interface ReadTarget {
  /** Files that carry no translatable keys, with why they were passed over. */
  skipped: Array<{ file: string; reason: string }>;
  leaves: Map<string, Leaf>;
  containers: Set<string>;
  /** gettext plural entries: base key -> number of msgstr forms present. */
  plurals: Map<string, number>;
  /** nplurals declared by a .po header, when there is one. */
  nplurals: number | null;
}

/** One locale, with every nested key flattened to dot notation. */
export interface LocaleBundle {
  locale: string;
  files: string[];
  skipped: Array<{ file: string; reason: string }>;
  /** Files that could not be parsed. One bad file must not hide the rest. */
  unreadable: Array<{ file: string; message: string }>;
  leaves: Map<string, Leaf>;
  /** Keys that hold an object or array rather than a value. */
  containers: Set<string>;
  plurals: Map<string, number>;
  nplurals: number | null;
}

export interface Config {
  root: string;
  localesDir: string;
  sourceLocale: string;
  locales: string[];
  layout: 'flat' | 'nested';
  placeholderSyntaxes: string[];
  /** Values legitimately identical to the source, e.g. "OK", "Email", brand names. */
  ignoreIdentical: string[];
  rules: Record<RuleId, RuleSetting>;
}

export interface LocaleStat {
  locale: string;
  sourceKeys: number;
  translated: number;
  coverage: number;
  missing: number;
  orphan: number;
  stale: number;
  errors: number;
  warnings: number;
}

export interface Report {
  localesDir: string;
  sourceLocale: string;
  sourceKeys: number;
  /** gettext carries its source text in every catalogue, not in one locale. */
  sourceFromMsgid: boolean;
  /** Whether a translation memory was available; without one, stale is unknowable. */
  memoryLoaded: boolean;
  stats: LocaleStat[];
  findings: Finding[];
}
