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
  identical_to_source: 'warning',
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
}

/** One locale, with every nested key flattened to dot notation. */
export interface LocaleBundle {
  locale: string;
  files: string[];
  leaves: Map<string, Leaf>;
  /** Keys that hold an object or array rather than a value. */
  containers: Set<string>;
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
  errors: number;
  warnings: number;
}

export interface Report {
  localesDir: string;
  sourceLocale: string;
  sourceKeys: number;
  stats: LocaleStat[];
  findings: Finding[];
}
