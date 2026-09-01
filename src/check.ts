import {
  containsTerm,
  expectationsFor,
  missingVerbatim,
  type Glossary,
} from './glossary.js';
import {
  allowanceFor,
  limitFor,
  measurable,
  renderedWidth,
  type Limits,
} from './lengths.js';
import { judge, type Memory } from './memory.js';
import { diffPlaceholders, extractPlaceholders } from './placeholders.js';
import {
  CATEGORY_NAMES,
  categoriesFor,
  categoryReachesFurther,
  pipeSegments,
  pluralGroups,
  scanIcu,
  splitPluralSuffix,
  type Category,
} from './plurals.js';
import { loadBundle, sourceIsMsgid } from './scan.js';
import type { Config, Finding, LocaleBundle, LocaleStat, Report, RuleId } from './types.js';

const HAS_LETTER = /\p{L}/u;

/** gettext plural forms are indexed, not named: base.0, base.1, base.2. */
const PLURAL_INDEX = /^(.*)\.(\d+)$/;

function pluralIndexBase(key: string): string | null {
  const match = PLURAL_INDEX.exec(key);
  return match ? match[1]! : null;
}

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

/** Drops the multiplicity, leaving which names were used but not how often. */
function distinct(counts: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const label of counts.keys()) out.set(label, 1);
  return out;
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

/**
 * The plural categories a target uses where the source had a plain string, or
 * null when the expansion is something else.
 */
function pluralExpansion(
  target: LocaleBundle,
  key: string,
  categories: Set<string> | null,
): Set<string> | null {
  if (!categories) return null;
  const prefix = `${key}.`;
  const used = new Set<string>();

  for (const candidate of target.leaves.keys()) {
    if (!candidate.startsWith(prefix)) continue;
    const rest = candidate.slice(prefix.length);
    if (rest.includes('.') || !categories.has(rest)) return null;
    used.add(rest);
  }

  return used.size > 0 ? used : null;
}

/**
 * Whether a target plural form is entitled to a placeholder its own source form
 * does without.
 *
 * Every form of one message is rendered from the same arguments, so a
 * placeholder the source uses in any form of the group will be substituted in
 * all of them. English writes `less_than_x_minutes.one` as "less than a minute"
 * because English `one` means exactly 1; Scottish Gaelic `one` also covers 11
 * and has to keep the count, and Afrikaans may keep it simply because "less
 * than 1 minute" reads better. Neither is an invented placeholder.
 *
 * What this does not excuse is a name the source never uses anywhere in the
 * group — that one really would render as literal text.
 */
function pluralNeedsPlaceholder(
  config: Config,
  source: LocaleBundle,
  key: string,
  extra: string[],
): boolean {
  const split = splitPluralSuffix(key);
  if (!split) return false;

  const elsewhere = groupPlaceholders(config, source, split);
  if (elsewhere.size === 0) return false;

  // `extra` labels carry a ` x2` suffix when a placeholder repeats.
  return extra.every((label) => elsewhere.has(label.replace(/ x\d+$/, '')));
}

/** What the source interpolates in the other forms of the same plural group. */
function groupPlaceholders(
  config: Config,
  source: LocaleBundle,
  split: { base: string; category: string; separator: '_' | '.' },
): Set<string> {
  const elsewhere = new Set<string>();
  for (const category of CATEGORY_NAMES) {
    if (category === split.category) continue;
    const leaf = source.leaves.get(`${split.base}${split.separator}${category}`);
    if (!leaf) continue;
    for (const label of extractPlaceholders(leaf.value, config.placeholderSyntaxes).keys()) {
      elsewhere.add(label);
    }
  }
  return elsewhere;
}

function checkLocale(
  config: Config,
  source: LocaleBundle,
  target: LocaleBundle,
  findings: Finding[],
  memory: Memory | null,
  glossary: Glossary | null,
  limits: Limits | null,
): LocaleStat {
  const before = findings.length;
  for (const bad of target.unreadable) {
    push(findings, config, 'unreadable_file', target.locale, bad.file, bad.file, bad.message);
  }
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

  // Only collected when the rule is on: one map per locale of source string ->
  // the distinct translations it received.
  const trackWording = config.rules.inconsistent_translation !== 'off';
  const wordings = new Map<string, Map<string, string>>();

  for (const [key, sourceLeaf] of source.leaves) {
    const targetLeaf = target.leaves.get(key);

    if (!targetLeaf) {
      const indexBase = pluralIndexBase(key);
      if (indexBase && (source.plurals.has(indexBase) || target.plurals.has(indexBase))) {
        // A catalogue carries as many forms as its own language needs.
        notApplicable++;
        continue;
      }

      const suffix = splitPluralSuffix(key);
      if (suffix && sourceGroups.has(suffix.base) && categories && !categories.has(suffix.category)) {
        // e.g. item_one has no counterpart in Japanese, which only has `other`.
        notApplicable++;
        continue;
      }

      const file = target.files[0] ?? target.locale;
      if (target.containers.has(key)) {
        structuralPrefixes.push(key + '.');
        // Arabic turning one English string into zero/one/two/few/many is
        // correct pluralisation, not a structural disagreement — so it is
        // judged as a plural group instead.
        const expanded = pluralExpansion(target, key, categories);
        if (expanded) {
          const absent = [...categories!].filter((c) => !expanded.has(c));
          if (absent.length > 0) {
            push(findings, config, 'plural_missing_category', target.locale, `${key}.*`, file,
              `${target.locale} needs ${list(categories!)}, has ${list(expanded)}`);
          }
          continue;
        }
        push(findings, config, 'structure_mismatch', target.locale, key, file,
          'value in source, object in target');
      } else {
        missing++;
        push(findings, config, 'missing_key', target.locale, key, file, 'not translated');
      }
      continue;
    }

    if (targetLeaf.value.trim() === '' && sourceLeaf.value.trim() !== '') {
      // An empty string is not a translation. gettext spells that as an empty
      // msgstr and i18next as "", and both mean the same as no key at all —
      // so they are one finding, not two ideas wearing different names.
      missing++;
      push(findings, config, 'missing_key', target.locale, key, targetLeaf.file,
        'present but empty');
      // Nothing further can be true of an empty string: it has no placeholders
      // to have lost, no plural forms to be missing, no width to overflow.
      continue;
    }
    translated++;

    if (
      targetLeaf.value === sourceLeaf.value &&
      HAS_LETTER.test(sourceLeaf.value) &&
      !ignore.has(sourceLeaf.value.toLowerCase())
    ) {
      push(findings, config, 'identical_to_source', target.locale, key, targetLeaf.file,
        `identical to source: "${truncate(sourceLeaf.value)}"`);
    }

    const sourcePlaceholders = extractPlaceholders(sourceLeaf.value, config.placeholderSyntaxes);
    const targetPlaceholders = extractPlaceholders(
      targetLeaf.value,
      config.placeholderSyntaxes,
      sourcePlaceholders.keys(),
    );
    // Laravel's pipe segments are alternatives: exactly one of them is ever
    // rendered. Japanese collapsing three English segments into one has not
    // lost two copies of :count, so the names are compared without their
    // counts — losing the name altogether is still reported.
    const alternatives = laravel && pipeSegments(sourceLeaf.value) > 1;
    const { missing: lost, extra } = diffPlaceholders(
      alternatives ? distinct(sourcePlaceholders) : sourcePlaceholders,
      alternatives ? distinct(targetPlaceholders) : targetPlaceholders,
    );

    if (lost.length > 0) {
      push(findings, config, 'placeholder_missing', target.locale, key, targetLeaf.file,
        `${lost.join(', ')} lost`);
    }
    if (
      extra.length > 0 &&
      !pluralNeedsPlaceholder(config, source, key, extra)
    ) {
      push(findings, config, 'placeholder_extra', target.locale, key, targetLeaf.file,
        `${extra.join(', ')} not in source`);
    }

    // Nothing is missing relative to the source here, which is exactly why no
    // other rule looks: the source form is complete for its own language and
    // incomplete for this one.
    const pluralForm = splitPluralSuffix(key);
    if (pluralForm) {
      const beyond = categoryReachesFurther(
        config.sourceLocale,
        target.locale,
        pluralForm.category,
      );
      // Only quantities above one. A category that additionally takes 0 —
      // French, Hindi, Persian all put it in `one` — is a fact about agreement,
      // not about quantity: zero minutes really is less than a minute. Eleven
      // of them is not.
      const quantities = beyond?.filter((n) => n > 1) ?? [];
      if (quantities.length > 0) {
        const needed = [...groupPlaceholders(config, source, pluralForm)].filter(
          (label) => !sourcePlaceholders.has(label) && !targetPlaceholders.has(label),
        );
        if (needed.length > 0) {
          push(findings, config, 'plural_needs_placeholder', target.locale, key, targetLeaf.file,
            `${needed.join(', ')} dropped, but ${pluralForm.category} in ${target.locale} also covers ${quantities.slice(0, 3).join(', ')}`);
        }
      }
    }

    if (glossary) {
      const lost = missingVerbatim(glossary, sourceLeaf.value, targetLeaf.value);
      if (lost.length > 0) {
        push(findings, config, 'dnt_violation', target.locale, key, targetLeaf.file,
          `${lost.join(', ')} must stay verbatim`);
      }

      for (const { term, accepted } of expectationsFor(glossary, target.locale, sourceLeaf.value)) {
        const satisfied = accepted.some((form) =>
          containsTerm(targetLeaf.value, form, term.match, term.caseSensitive),
        );
        if (!satisfied) {
          push(findings, config, 'glossary_violation', target.locale, key, targetLeaf.file,
            `"${term.source}" should be ${accepted.map((f) => `"${f}"`).join(' or ')}`);
        }
      }
    }

    if (trackWording && HAS_LETTER.test(sourceLeaf.value) && sourceLeaf.value.length >= 4) {
      let variants = wordings.get(sourceLeaf.value);
      if (!variants) {
        variants = new Map();
        wordings.set(sourceLeaf.value, variants);
      }
      if (!variants.has(targetLeaf.value)) variants.set(targetLeaf.value, key);
    }

    checkLength(
      config, findings, target.locale, key, targetLeaf.file, limits, laravel,
      targetLeaf.value, sourceLeaf.value,
    );

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
    if (targetLeaf.fuzzy) {
      // gettext already tracks this; no translation memory needed.
      stale++;
      push(findings, config, 'stale', target.locale, key, targetLeaf.file,
        'marked fuzzy in the catalogue');
    } else if (verdict.stale) {
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

    const indexBase = pluralIndexBase(key);
    if (indexBase && (source.plurals.has(indexBase) || target.plurals.has(indexBase))) continue;

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

  // gettext states its own form count in the catalogue header, so this one is
  // internally checkable without consulting CLDR at all.
  if (target.nplurals !== null) {
    for (const [base, forms] of target.plurals) {
      if (forms === target.nplurals) continue;
      push(findings, config, 'plural_missing_category', target.locale, base,
        target.files[0] ?? target.locale,
        `header declares nplurals=${target.nplurals}, entry has ${forms}`);
    }
  }

  // Suffix-key plural groups, checked per group rather than per key.
  if (categories) {
    for (const base of sourceGroups.keys()) {
      const have = targetGroups.get(base);
      if (!have) continue; // the whole group is missing; already reported above

      // Named the way the project writes it: item_one for i18next, item.one for
      // Rails and Symfony.
      const label = `${base}${have.separator}*`;

      const absent = [...categories].filter((c) => !have.categories.has(c as Category));
      if (absent.length > 0) {
        push(findings, config, 'plural_missing_category', target.locale, label,
          target.files[0] ?? target.locale,
          `${target.locale} needs ${list(categories)}, has ${list(have.categories)}`);
      }

      const extra = [...have.categories].filter((c) => !categories.has(c));
      if (extra.length > 0) {
        push(findings, config, 'plural_extra_category', target.locale, label,
          target.files[0] ?? target.locale,
          `${list(extra)} is not a plural category in ${target.locale}`);
      }
    }
  }

  for (const [sourceValue, variants] of wordings) {
    if (variants.size < 2) continue;
    const keys = [...variants.values()];
    push(findings, config, 'inconsistent_translation', target.locale, keys[0]!,
      target.files[0] ?? target.locale,
      `"${truncate(sourceValue)}" is translated ${variants.size} ways, also at ${keys.slice(1).join(', ')}`);
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

/**
 * Text is measured in display columns and only where measuring means something:
 * an ICU plural holds every branch at once but shows one, and Laravel's pipes
 * select between forms, so only the widest segment can ever appear.
 */
function checkLength(
  config: Config,
  findings: Finding[],
  locale: string,
  key: string,
  file: string,
  limits: Limits | null,
  laravel: boolean,
  value: string,
  sourceValue: string | null,
): void {
  if (!measurable(value)) return;
  const width = renderedWidth(value, laravel);

  const max = limits ? limitFor(limits, key) : null;
  if (max !== null && width > max) {
    push(findings, config, 'length_over_max', locale, key, file,
      `${width} columns, limit ${max}`);
  }

  if (sourceValue === null || !measurable(sourceValue)) return;
  const sourceWidth = renderedWidth(sourceValue, laravel);
  if (sourceWidth === 0) return;

  const allowed = allowanceFor(sourceWidth);
  if (width > sourceWidth * allowed) {
    const percent = Math.round((width / sourceWidth) * 100);
    push(findings, config, 'length_overflow', locale, key, file,
      `${width} columns vs ${sourceWidth} in source — ${percent}%, allowance ${Math.round(allowed * 100)}%`);
  }
}

/** A broken or oversized source string is broken for every language. */
function checkSource(
  config: Config,
  source: LocaleBundle,
  findings: Finding[],
  limits: Limits | null,
): void {
  for (const bad of source.unreadable) {
    push(findings, config, 'unreadable_file', source.locale, bad.file, bad.file, bad.message);
  }
  const categories = categoriesFor(source.locale);
  const laravel = config.placeholderSyntaxes.includes('laravel');
  for (const [key, leaf] of source.leaves) {
    checkIcuCategories(
      config, findings, source.locale, categories, key, leaf.file, leaf.value,
    );
    checkLength(config, findings, source.locale, key, leaf.file, limits, laravel, leaf.value, null);
  }
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const SEVERITY_ORDER = { error: 0, warning: 1 } as const;

export function check(
  config: Config,
  memory: Memory | null = null,
  glossary: Glossary | null = null,
  limits: Limits | null = null,
): Report {
  const source = loadBundle(config, config.sourceLocale);
  const findings: Finding[] = [];
  const stats: LocaleStat[] = [];

  checkSource(config, source, findings, limits);

  for (const locale of config.locales) {
    if (locale === config.sourceLocale) continue;
    stats.push(
      checkLocale(config, source, loadBundle(config, locale), findings, memory, glossary, limits),
    );
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
    sourceFromMsgid: sourceIsMsgid(source),
    memoryLoaded: memory !== null,
    stats,
    findings,
  };
}
