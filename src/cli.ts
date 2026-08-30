#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { existsSync } from 'node:fs';
import { applyProposals, ApplyError } from './apply.js';
import { check } from './check.js';
import { FormatError, describeFormatError } from './formats/error.js';
import {
  GlossaryError,
  glossaryPath,
  loadGlossary,
  type Glossary,
} from './glossary.js';
import { LimitsError, limitsPath, loadLimits, type Limits } from './lengths.js';
import {
  MemoryError,
  emptyMemory,
  hashValue,
  loadMemory,
  memoryPath,
  saveMemory,
  syncMemory,
  type Memory,
} from './memory.js';
import { renderReport } from './report.js';
import {
  collectJobs,
  runTranslation,
  DEFAULT_BATCH,
  DEFAULT_CAP,
  DEFAULT_MODEL,
} from './translate.js';
import { ALL_SYNTAXES } from './placeholders.js';
import { ScanError, detectProject, listLocales, loadBundle } from './scan.js';
import { RULE_IDS, type Config, type RuleId } from './types.js';

const VERSION = '0.1.0';

const HELP = `i18n-keeper ${VERSION}

  i18n-keeper check [path]    lint locale files
  i18n-keeper scan  [path]    show what would be checked
  i18n-keeper sync  [path]    record current translations in the memory
  i18n-keeper translate [path]  fill the missing and stale set with Claude

Options
  --locales <dir>       locales directory (default: auto-detect)
  --source <locale>     source locale (default: en, else the first found)
  --locale <locale>     limit to this locale (repeatable)
  --memory <file>       translation memory (default: .i18n/memory.json)
  --no-memory           ignore the memory; disables stale detection
  --glossary <file>     glossary (default: .i18n/glossary.json)
  --no-glossary         ignore the glossary
  --limits <file>       width limits (default: .i18n/limits.json)
  --no-limits           ignore the width limits

check
  --rule <rule>         only report this rule (repeatable)
  --ignore-identical <a,b>   values allowed to equal the source, e.g. OK,Email
  --syntax <a,b>        placeholder syntaxes: ${ALL_SYNTAXES.join(', ')}
  --limit <n>           max findings to print (default: 40)
  --json                machine-readable output

sync
  --origin <human|machine>   who produced these translations (default: human)
  --force               also re-record unchanged translations, clearing stale

translate
  --write               apply accepted translations (otherwise nothing is written)
  --cap <n>             most strings to translate in one run (default: ${DEFAULT_CAP})
  --batch <n>           strings per request (default: ${DEFAULT_BATCH})
  --model <id>          default: ${DEFAULT_MODEL}
  --effort <level>      low|medium|high|xhigh|max (default: medium)

  Sends the source strings, their keys and their constraints to the Anthropic
  API. Every proposal is re-checked locally and rejected if it breaks a rule.

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
        glossary: { type: 'string' },
        'no-glossary': { type: 'boolean' },
        limits: { type: 'string' },
        'no-limits': { type: 'boolean' },
        'ignore-identical': { type: 'string' },
        syntax: { type: 'string' },
        origin: { type: 'string' },
        force: { type: 'boolean' },
        write: { type: 'boolean' },
        model: { type: 'string' },
        effort: { type: 'string' },
        batch: { type: 'string' },
        cap: { type: 'string' },
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
if (
  command !== 'check' &&
  command !== 'scan' &&
  command !== 'sync' &&
  command !== 'translate'
) {
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

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const effort = values.effort ?? 'medium';
if (!(EFFORTS as readonly string[]).includes(effort)) {
  fail(`--effort expects one of: ${EFFORTS.join(', ')}`);
}

function positive(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) fail(`${flag} expects a positive number`);
  return parsed;
}

const cap = positive('--cap', values.cap, DEFAULT_CAP);
const batchSize = positive('--batch', values.batch, DEFAULT_BATCH);

/** An explicit --limits must exist; the default path is simply optional. */
function openLimits(config: Config): { limits: Limits | null; file: string } {
  const file = limitsPath(config.root, values.limits);
  if (values['no-limits']) return { limits: null, file };
  if (values.limits && !existsSync(file)) fail(`Limits file not found: ${file}`);
  return { limits: loadLimits(file), file };
}

/** An explicit --glossary must exist; the default path is simply optional. */
function openGlossary(config: Config): { glossary: Glossary | null; file: string } {
  const file = glossaryPath(config.root, values.glossary);
  if (values['no-glossary']) return { glossary: null, file };
  if (values.glossary && !existsSync(file)) fail(`Glossary file not found: ${file}`);
  return { glossary: loadGlossary(file), file };
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
    const glossaryInfo = openGlossary(config);
    const limitsInfo = openLimits(config);
    const summary = {
      localesDir: config.localesDir,
      layout,
      sourceLocale: config.sourceLocale,
      locales,
      placeholderSyntaxes: config.placeholderSyntaxes,
      memory: memory ? file : null,
      glossary: glossaryInfo.glossary ? glossaryInfo.file : null,
      limits: limitsInfo.limits ? limitsInfo.file : null,
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
          `glossary     ${
            glossaryInfo.glossary
              ? `${relative(config.root, glossaryInfo.file)} (${glossaryInfo.glossary.terms.length} terms, ${glossaryInfo.glossary.doNotTranslate.length} verbatim)`
              : 'none'
          }`,
          `limits       ${
            limitsInfo.limits
              ? `${relative(config.root, limitsInfo.file)} (${Object.keys(limitsInfo.limits.keys).length} keys, ${limitsInfo.limits.patterns.length} patterns)`
              : 'none'
          }`,
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

  if (command === 'translate') {
    const { memory: existing } = openMemory(config);
    const { glossary } = openGlossary(config);
    const { limits } = openLimits(config);

    const report = check(config, existing, glossary, limits);
    const source = loadBundle(config, config.sourceLocale);
    let jobs = collectJobs(config, report.findings, source, glossary, limits, values.locale);

    const total = jobs.length;
    if (total === 0) {
      process.stdout.write('Nothing to translate: no missing, empty or stale strings.\n');
      process.exit(0);
    }
    if (total > cap) jobs = jobs.slice(0, cap);

    const locales = [...new Set(jobs.map((job) => job.locale))];
    process.stdout.write(
      [
        `Sending ${jobs.length} string${jobs.length === 1 ? '' : 's'} ` +
          `(${locales.join(', ')}) to ${values.model ?? DEFAULT_MODEL} at effort ${effort}.`,
        total > cap ? `${total - cap} more are waiting; raise --cap to include them.` : '',
      ]
        .filter(Boolean)
        .join('\n') + '\n',
    );

    const run = await runTranslation(config, jobs, glossary, {
      model: values.model ?? DEFAULT_MODEL,
      effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
      batchSize,
      onBatch: (locale, size, attempt) => {
        process.stderr.write(
          `  ${locale}: ${size} string${size === 1 ? '' : 's'}${attempt > 1 ? ' (retry)' : ''}\n`,
        );
      },
    });

    const proposals = run.proposals;

    if (values.json) {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      process.exit(run.aborted || proposals.some((p) => !p.accepted) ? 1 : 0);
    }

    const accepted = proposals.filter((p) => p.accepted);
    const rejected = proposals.filter((p) => !p.accepted);

    for (const proposal of accepted) {
      process.stdout.write(`  ${proposal.locale}  ${proposal.key}\n    ${proposal.value}\n`);
    }
    if (rejected.length > 0) {
      process.stdout.write('\nrejected\n');
      for (const proposal of rejected) {
        process.stdout.write(
          `  ${proposal.locale}  ${proposal.key}\n` +
            `    ${proposal.value || '(nothing returned)'}\n` +
            proposal.rejections.map((r) => `    ! ${r}\n`).join(''),
        );
      }
    }

    process.stdout.write(`\n${accepted.length} accepted, ${rejected.length} rejected\n`);

    // An error that is not a content refusal stopped the run before the checks
    // could say anything, so it must not be reported as a rejection.
    if (run.aborted) {
      const hint = /authentication|api[ _-]?key|credential|unauthor/i.test(run.aborted)
        ? '\nSet ANTHROPIC_API_KEY, or sign in with `ant auth login`.'
        : '';
      fail(
        `Translation stopped: ${run.aborted}\n` +
          `${jobs.length - proposals.length} of ${jobs.length} strings were never attempted.${hint}`,
      );
    }

    if (!values.write) {
      process.stdout.write('Nothing written. Pass --write to apply the accepted ones.\n');
      process.exit(rejected.length > 0 ? 1 : 0);
    }

    const applied = applyProposals(config, source, proposals);
    const memoryFile = memoryPath(config.root, values.memory);
    const memory = existing ?? emptyMemory(config.sourceLocale);
    const now = new Date().toISOString();
    for (const proposal of accepted) {
      const byKey = (memory.entries[proposal.locale] ??= {});
      byKey[proposal.key] = {
        sourceHash: hashValue(proposal.source),
        value: proposal.value,
        origin: 'machine',
        reviewed: false,
        updatedAt: now,
      };
    }
    saveMemory(memoryFile, memory);

    process.stdout.write(
      `Wrote ${applied.written} string${applied.written === 1 ? '' : 's'} to ` +
        `${applied.files.length} file${applied.files.length === 1 ? '' : 's'}, ` +
        `recorded as unreviewed machine output in ${relative(config.root, memoryFile)}.\n`,
    );
    for (const skip of applied.skipped) {
      process.stdout.write(`  not written: ${skip.locale} ${skip.key} — ${skip.reason}\n`);
    }

    process.exit(rejected.length > 0 ? 1 : 0);
  }

  const localeFilter = new Set(values.locale ?? []);
  const ruleFilter = new Set((values.rule ?? []) as RuleId[]);

  // Naming a rule explicitly turns it on; otherwise --rule untracked, which is
  // off by default, would print nothing and look broken.
  for (const rule of ruleFilter) {
    if (config.rules[rule] === 'off') config.rules[rule] = 'warning';
  }

  const { memory } = openMemory(config);
  const { glossary } = openGlossary(config);
  const { limits } = openLimits(config);
  const report = check(config, memory, glossary, limits);
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
  if (err instanceof GlossaryError) fail(err.message);
  if (err instanceof LimitsError) fail(err.message);
  if (err instanceof ApplyError) fail(err.message);
  if (err instanceof FormatError) fail(describeFormatError(err));
  throw err;
}
