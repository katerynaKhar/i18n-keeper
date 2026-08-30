import { judge, type Memory } from './memory.js';
import { diffPlaceholders, extractPlaceholders } from './placeholders.js';
import {
  categoriesFor,
  pipeSegments,
  pluralGroups,
  scanIcu,
  splitPluralSuffix,
  type Category,
} from './plurals.js';
import { loadBundle } from './scan.js';
import type { Config, Finding, LocaleBundle, LocaleStat, Report, RuleId } from './types.js';

const HAS_LETTER = /\p{L}/u;

function push(
  findings: Finding[],
  config: Config,
  rule: RuleId,
  locale: string,
  key: string,
  file: string,
  detail: string,
): void {
  const setting = config.rules[rule];
  if (setting === 'off') return;
  findings.push({ rule, severity: setting, locale, key, file, detail });
}

function list(categories: Iterable<string>): string {
  return [...categories].join('/');
}

/** ICU plural branches must cover the categories the target language actually has. */
function checkIcuCategories(
  config: Config,
  findings: Finding[],
  locale: string,
  categories: Set<string> | null,
  key: string,
  file: string,
  value: string,
): void {
  const scan = scanIcu(value);

  if (scan.error) {
    push(findings, config, 'icu_syntax_error', locale, key, file, scan.error);
    return;
  }
  if (!categories) return;

  for (const block of scan.blocks) {
    const absent = [...categories].filter((c) => !block.categories.has(c));
    if (absent.length > 0) {
      push(findings, config, 'plural_missing_category', locale, key, file,
        `${locale} needs ${list(categories)}, has ${list(block.categories) || 'none'}`);
    }
    const extra = [...block.categories].filter((c) => !categories.has(c));
    if (extra.length > 0) {
      push(findings, config, 'plural_extra_category', locale, key, file,
        `${list(extra)} is not a plural category in ${locale}`);
    }
  }
}

function checkLocale(
  config: Config,
  source: LocaleBundle,
  target: LocaleBundle,
  findings: Finding[],
  memory: Memory | null,
): LocaleStat {
  const before = findings.length;
  const ignore = new Set(config.ignoreIdentical.map((s) => s.toLowerCase()));
  const structuralPrefixes: string[] = [];

  // Plural forms differ per language, so a key present in the source is not
  // automatically required here, and a key absent from the source is not
  // automatically dead.
  const categories = categoriesFor(target.locale);
  const sourceGroups = pluralGroups(source.leaves.keys());
  const targetGroups = pluralGroups(target.leaves.keys());
  const laravel = config.placeholderSyntaxes.includes('laravel');

  let translated = 0;
  let missing = 0;
  let orphan = 0;
  let stale = 0;
  let notApplicable = 0;

  for (const [key, sourceLeaf] of source.leaves) {
    const targetLeaf = target.leaves.get(key);

    if (!targetLeaf) {
      const suffix = splitPluralSuffix(key);
      if (suffix && sourceGroups.has(suffix.base) && categories && !categories.has(suffix.category)) {
        // e.g. item_one has no counterpart in Japanese, which only has `other`.
        notApplicable++;
        continue;
      }

      const file = target.files[0] ?? target.locale;
      if (target.containers.has(key)) {
        structuralPrefixes.push(key + '.');
        push(findings, config, 'structure_mismatch', target.locale, key, file,
          'value in source, object in target');
      } else {
        missing++;
        push(findings, config, 'missing_key', target.locale, key, file, 'not translated');
      }
      continue;
    }

    if (targetLeaf.value.trim() === '' && sourceLeaf.value.trim() !== '') {
      push(findings, config, 'empty_value', target.locale, key, targetLeaf.file, 'empty string');
    } else {
      translated++;
    }

    if (
      targetLeaf.value === sourceLeaf.value &&
      HAS_LETTER.test(sourceLeaf.value) &&
      !ignore.has(sourceLeaf.value.toLowerCase())
    ) {
      push(findings, config, 'identical_to_source', target.locale, key, targetLeaf.file,
        `identical to source: "${truncate(sourceLeaf.value)}"`);
    }

    const sourcePlaceholders = extractPlaceholders(sourceLeaf.value, config.placeholderSyntaxes);
    const targetPlaceholders = extractPlaceholders(targetLeaf.value, config.placeholderSyntaxes);
    const { missing: lost, extra } = diffPlaceholders(sourcePlaceholders, targetPlaceholders);

    if (lost.length > 0) {
      push(findings, config, 'placeholder_missing', target.locale, key, targetLeaf.file,
        `${lost.join(', ')} lost`);
    }
    if (extra.length > 0) {
      push(findings, config, 'placeholder_extra', target.locale, key, targetLeaf.file,
        `${extra.join(', ')} not in source`);
    }

    checkIcuCategories(
      config, findings, target.locale, categories, key, targetLeaf.file, targetLeaf.value,
    );

    // Laravel selects a segment by position or explicit range, which is its own
    // mechanism, not CLDR. The one thing that is unambiguously wrong is losing
    // the selection entirely: trans_choice would then return one string for
    // every count.
    if (laravel && pipeSegments(sourceLeaf.value) > 1 && pipeSegments(targetLeaf.value) === 1) {
      push(findings, config, 'plural_selector_lost', target.locale, key, targetLeaf.file,
        'source selects between forms with |, translation has a single form');
    }

    const verdict = judge(memory?.entries[target.locale]?.[key], sourceLeaf.value, targetLeaf.value);
    if (verdict.stale) {
      stale++;
      push(findings, config, 'stale', target.locale, key, targetLeaf.file,
        'source changed after this translation was recorded');
    } else if (memory && !verdict.tracked) {
      push(findings, config, 'untracked', target.locale, key, targetLeaf.file,
        'no memory entry; run sync');
    }
  }

  for (const [key, leaf] of target.leaves) {
    if (source.leaves.has(key)) continue;
    // Already reported as a structure mismatch one level up; not a separate orphan.
    if (structuralPrefixes.some((prefix) => key.startsWith(prefix))) continue;

    const suffix = splitPluralSuffix(key);
    if (suffix && sourceGroups.has(suffix.base) && categories?.has(suffix.category)) {
      // e.g. item_few exists in Polish and not in English. That is the point.
      continue;
    }

    if (source.containers.has(key)) {
      push(findings, config, 'structure_mismatch', target.locale, key, leaf.file,
        'object in source, value in target');
      continue;
    }
    orphan++;
    push(findings, config, 'orphan_key', target.locale, key, leaf.file, 'not in source locale');
  }

  // Suffix-key plural groups, checked per group rather than per key.
  if (categories) {
    for (const base of sourceGroups.keys()) {
      const have = targetGroups.get(base);
      if (!have) continue; // the whole group is missing; already reported above

      const absent = [...categories].filter((c) => !have.has(c as Category));
      if (absent.length > 0) {
        push(findings, config, 'plural_missing_category', target.locale, `${base}_*`,
          target.files[0] ?? target.locale,
          `${target.locale} needs ${list(categories)}, has ${list(have)}`);
      }

      const extra = [...have].filter((c) => !categories.has(c));
      if (extra.length > 0) {
        push(findings, config, 'plural_extra_category', target.locale, `${base}_*`,
          target.files[0] ?? target.locale,
          `${list(extra)} is not a plural category in ${target.locale}`);
      }
    }
  }

  const added = findings.slice(before);
  const applicable = source.leaves.size - notApplicable;

  return {
    locale: target.locale,
    sourceKeys: source.leaves.size,
    translated,
    // Keys that the target language has no grammatical use for are left out of
    // the denominator, so a complete Japanese locale still reads as 100%.
    coverage: applicable <= 0 ? 1 : translated / applicable,
    missing,
    orphan,
    stale,
    errors: added.filter((f) => f.severity === 'error').length,
    warnings: added.filter((f) => f.severity === 'warning').length,
  };
}

/** A broken ICU string in the source locale is broken for every language. */
function checkSource(config: Config, source: LocaleBundle, findings: Finding[]): void {
  const categories = categoriesFor(source.locale);
  for (const [key, leaf] of source.leaves) {
    checkIcuCategories(
      config, findings, source.locale, categories, key, leaf.file, leaf.value,
    );
  }
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const SEVERITY_ORDER = { error: 0, warning: 1 } as const;

export function check(config: Config, memory: Memory | null = null): Report {
  const source = loadBundle(config, config.sourceLocale);
  const findings: Finding[] = [];
  const stats: LocaleStat[] = [];

  checkSource(config, source, findings);

  for (const locale of config.locales) {
    if (locale === config.sourceLocale) continue;
    stats.push(checkLocale(config, source, loadBundle(config, locale), findings, memory));
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.locale.localeCompare(b.locale) ||
      a.key.localeCompare(b.key) ||
      a.rule.localeCompare(b.rule),
  );

  return {
    localesDir: config.localesDir,
    sourceLocale: config.sourceLocale,
    sourceKeys: source.leaves.size,
    memoryLoaded: memory !== null,
    stats,
    findings,
  };
}
