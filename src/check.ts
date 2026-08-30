import { diffPlaceholders, extractPlaceholders } from './placeholders.js';
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

function checkLocale(
  config: Config,
  source: LocaleBundle,
  target: LocaleBundle,
  findings: Finding[],
): LocaleStat {
  const before = findings.length;
  const ignore = new Set(config.ignoreIdentical.map((s) => s.toLowerCase()));
  const structuralPrefixes: string[] = [];
  let translated = 0;
  let missing = 0;
  let orphan = 0;

  for (const [key, sourceLeaf] of source.leaves) {
    const targetLeaf = target.leaves.get(key);

    if (!targetLeaf) {
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
  }

  for (const [key, leaf] of target.leaves) {
    if (source.leaves.has(key)) continue;
    // Already reported as a structure mismatch one level up; not a separate orphan.
    if (structuralPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (source.containers.has(key)) {
      push(findings, config, 'structure_mismatch', target.locale, key, leaf.file,
        'object in source, value in target');
      continue;
    }
    orphan++;
    push(findings, config, 'orphan_key', target.locale, key, leaf.file, 'not in source locale');
  }

  const added = findings.slice(before);
  const sourceKeys = source.leaves.size;

  return {
    locale: target.locale,
    sourceKeys,
    translated,
    coverage: sourceKeys === 0 ? 1 : translated / sourceKeys,
    missing,
    orphan,
    errors: added.filter((f) => f.severity === 'error').length,
    warnings: added.filter((f) => f.severity === 'warning').length,
  };
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const SEVERITY_ORDER = { error: 0, warning: 1 } as const;

export function check(config: Config): Report {
  const source = loadBundle(config, config.sourceLocale);
  const findings: Finding[] = [];
  const stats: LocaleStat[] = [];

  for (const locale of config.locales) {
    if (locale === config.sourceLocale) continue;
    stats.push(checkLocale(config, source, loadBundle(config, locale), findings));
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
    stats,
    findings,
  };
}
