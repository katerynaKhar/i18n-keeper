#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { existsSync } from 'node:fs';
import { check } from './check.js';
import { ParseError } from './formats/json.js';
import {
  MemoryError,
  emptyMemory,
  loadMemory,
  memoryPath,
  saveMemory,
  syncMemory,
  type Memory,
} from './memory.js';
import { renderReport } from './report.js';
import { ALL_SYNTAXES } from './placeholders.js';
import { ScanError, detectProject, listLocales } from './scan.js';
import { RULE_IDS, type Config, type RuleId } from './types.js';

const VERSION = '0.1.0';

const HELP = `i18n-keeper ${VERSION}

  i18n-keeper check [path]    lint locale files
  i18n-keeper scan  [path]    show what would be checked
  i18n-keeper sync  [path]    record current translations in the memory

Options
  --locales <dir>       locales directory (default: auto-detect)
  --source <locale>     source locale (default: en, else the first found)
  --locale <locale>     limit to this locale (repeatable)
  --memory <file>       translation memory (default: .i18n/memory.json)
  --no-memory           ignore the memory; disables stale detection

check
  --rule <rule>         only report this rule (repeatable)
  --ignore-identical <a,b>   values allowed to equal the source, e.g. OK,Email
  --syntax <a,b>        placeholder syntaxes: ${ALL_SYNTAXES.join(', ')}
  --limit <n>           max findings to print (default: 40)
  --json                machine-readable output

sync
  --origin <human|machine>   who produced these translations (default: human)
  --force               also re-record unchanged translations, clearing stale

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
        memory: { type: 'string' },
        'no-memory': { type: 'boolean' },
        'ignore-identical': { type: 'string' },
        syntax: { type: 'string' },
        origin: { type: 'string' },
        force: { type: 'boolean' },
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
if (command !== 'check' && command !== 'scan' && command !== 'sync') {
  fail(`Unknown command: ${command}\n\n${HELP}`);
}

const root = positionals[1] ?? process.cwd();

const limit = values.limit === undefined ? 40 : Number.parseInt(values.limit, 10);
if (!Number.isFinite(limit) || limit < 0) fail('--limit expects a non-negative number');

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

const origin = values.origin ?? 'human';
if (origin !== 'human' && origin !== 'machine') {
  fail('--origin expects "human" or "machine"');
}

/** An explicit --memory must exist; the default path is simply optional. */
function openMemory(config: Config): { memory: Memory | null; file: string } {
  const file = memoryPath(config.root, values.memory);
  if (values['no-memory']) return { memory: null, file };
  if (values.memory && !existsSync(file)) fail(`Memory file not found: ${file}`);
  return { memory: loadMemory(file), file };
}

try {
  const config = detectProject(root, { localesDir: values.locales, sourceLocale: values.source });
  if (syntaxes && syntaxes.length > 0) config.placeholderSyntaxes = syntaxes;
  if (values['ignore-identical']) {
    config.ignoreIdentical = values['ignore-identical']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (command === 'scan') {
    const { layout, locales } = listLocales(config.localesDir);
    const { memory, file } = openMemory(config);
    const summary = {
      localesDir: config.localesDir,
      layout,
      sourceLocale: config.sourceLocale,
      locales,
      placeholderSyntaxes: config.placeholderSyntaxes,
      memory: memory ? file : null,
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
          `memory       ${memory ? relative(config.root, file) : 'none'}`,
          '',
        ].join('\n'),
      );
    }
    process.exit(0);
  }

  if (command === 'sync') {
    const file = memoryPath(config.root, values.memory);
    const memory = (values['no-memory'] ? null : loadMemory(file)) ?? emptyMemory(config.sourceLocale);
    const result = syncMemory(config, memory, {
      origin,
      reviewed: origin === 'human',
      locales: values.locale,
      force: values.force === true,
    });
    saveMemory(file, memory);

    if (values.json) {
      process.stdout.write(`${JSON.stringify({ memory: file, ...result }, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `memory  ${relative(config.root, file)}`,
          `created ${result.created}  updated ${result.updated}  ` +
            `kept-stale ${result.keptStale}  unchanged ${result.unchanged}  removed ${result.removed}`,
          result.keptStale > 0 && !values.force
            ? `\n${result.keptStale} translation(s) still stale — retranslate them, or run sync --force to accept as-is.`
            : '',
        ]
          .filter(Boolean)
          .join('\n') + '\n',
      );
    }
    process.exit(0);
  }

  const localeFilter = new Set(values.locale ?? []);
  const ruleFilter = new Set((values.rule ?? []) as RuleId[]);

  // Naming a rule explicitly turns it on; otherwise --rule untracked, which is
  // off by default, would print nothing and look broken.
  for (const rule of ruleFilter) {
    if (config.rules[rule] === 'off') config.rules[rule] = 'warning';
  }

  const { memory } = openMemory(config);
  const report = check(config, memory);
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
      process.stdout.write(`(list filtered to: ${[...ruleFilter].join(', ')})\n`);
    }
  }

  process.exit(report.findings.some((f) => f.severity === 'error') ? 1 : 0);
} catch (err) {
  if (err instanceof ScanError) fail(err.message);
  if (err instanceof MemoryError) fail(err.message);
  if (err instanceof ParseError) fail(`Invalid JSON in ${err.file}\n  ${err.message}`);
  throw err;
}
