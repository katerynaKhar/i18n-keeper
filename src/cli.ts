#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { check } from './check.js';
import { ParseError } from './formats/json.js';
import { renderReport } from './report.js';
import { ALL_SYNTAXES } from './placeholders.js';
import { ScanError, detectProject, listLocales } from './scan.js';
import { RULE_IDS, type RuleId } from './types.js';

const VERSION = '0.0.1';

const HELP = `i18n-keeper ${VERSION}

  i18n-keeper check [path]    lint locale files
  i18n-keeper scan  [path]    show what would be checked

Options
  --locales <dir>       locales directory (default: auto-detect)
  --source <locale>     source locale (default: en, else the first found)
  --locale <locale>     only report this target locale (repeatable)
  --rule <rule>         only report this rule (repeatable)
  --ignore-identical <a,b>   values allowed to equal the source, e.g. OK,Email
  --syntax <a,b>        placeholder syntaxes: ${ALL_SYNTAXES.join(', ')}
  --limit <n>           max findings to print (default: 40)
  --json                machine-readable output
  --help, --version

Exits 1 when there is at least one error.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        locales: { type: 'string' },
        source: { type: 'string' },
        locale: { type: 'string', multiple: true },
        rule: { type: 'string', multiple: true },
        'ignore-identical': { type: 'string' },
        syntax: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

if (values.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const command = positionals[0] ?? 'check';
if (values.help || command === 'help') {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
if (command !== 'check' && command !== 'scan') {
  fail(`Unknown command: ${command}\n\n${HELP}`);
}

const root = positionals[1] ?? process.cwd();

const limit = values.limit === undefined ? 40 : Number.parseInt(values.limit, 10);
if (!Number.isFinite(limit) || limit < 0) fail(`--limit expects a non-negative number`);

for (const rule of values.rule ?? []) {
  if (!(RULE_IDS as readonly string[]).includes(rule)) {
    fail(`Unknown rule: ${rule}\nAvailable: ${RULE_IDS.join(', ')}`);
  }
}

const syntaxes = values.syntax?.split(',').map((s) => s.trim()).filter(Boolean);
for (const syntax of syntaxes ?? []) {
  if (!ALL_SYNTAXES.includes(syntax)) {
    fail(`Unknown placeholder syntax: ${syntax}\nAvailable: ${ALL_SYNTAXES.join(', ')}`);
  }
}

try {
  const config = detectProject(root, { localesDir: values.locales, sourceLocale: values.source });
  if (syntaxes && syntaxes.length > 0) config.placeholderSyntaxes = syntaxes;
  if (values['ignore-identical']) {
    config.ignoreIdentical = values['ignore-identical'].split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (command === 'scan') {
    const { layout, locales } = listLocales(config.localesDir);
    const summary = {
      localesDir: config.localesDir,
      layout,
      sourceLocale: config.sourceLocale,
      locales,
      placeholderSyntaxes: config.placeholderSyntaxes,
    };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `locales dir  ${summary.localesDir}`,
          `layout       ${summary.layout}`,
          `source       ${summary.sourceLocale}`,
          `locales      ${summary.locales.join(', ')}`,
          `placeholders ${summary.placeholderSyntaxes.join(', ')}`,
          '',
        ].join('\n'),
      );
    }
    process.exit(0);
  }

  const report = check(config);

  const localeFilter = new Set(values.locale ?? []);
  const ruleFilter = new Set((values.rule ?? []) as RuleId[]);
  if (localeFilter.size > 0 || ruleFilter.size > 0) {
    report.findings = report.findings.filter(
      (f) =>
        (localeFilter.size === 0 || localeFilter.has(f.locale)) &&
        (ruleFilter.size === 0 || ruleFilter.has(f.rule)),
    );
    if (localeFilter.size > 0) {
      report.stats = report.stats.filter((s) => localeFilter.has(s.locale));
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report, config.root, limit)}\n`);
    if (ruleFilter.size > 0) {
      // The table stays project-wide on purpose; only the list below it is filtered.
      process.stdout.write(`(list filtered to: ${[...ruleFilter].join(', ')})
`);
    }
  }

  process.exit(report.findings.some((f) => f.severity === 'error') ? 1 : 0);
} catch (err) {
  if (err instanceof ScanError) fail(err.message);
  if (err instanceof ParseError) fail(`Invalid JSON in ${err.file}\n  ${err.message}`);
  throw err;
}
