#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
  loadMemory,
  memoryPath,
  saveMemory,
  syncMemory,
  type Memory,
} from './memory.js';
import { ALL_SYNTAXES } from './placeholders.js';
import { ScanError, detectProject, listLocales } from './scan.js';
import { RULE_IDS, type Config, type Finding, type Report, type RuleId } from './types.js';
import { VERSION } from './version.js';

/**
 * Everything a tool returns lands in the agent's context, so the text stays
 * compact and findings are paged rather than dumped.
 */
const DEFAULT_LIMIT = 25;

const commonInput = {
  path: z.string().optional().describe('Project root. Defaults to the working directory.'),
  localesDir: z.string().optional().describe('Locales directory. Auto-detected when omitted.'),
  source: z.string().optional().describe('Source locale. Defaults to en, else the first found.'),
  memory: z.string().optional().describe('Translation memory file. Defaults to .i18n/memory.json.'),
  glossary: z.string().optional().describe('Glossary file. Defaults to .i18n/glossary.json.'),
  limits: z.string().optional().describe('Width limits file. Defaults to .i18n/limits.json.'),
};

const statShape = {
  locale: z.string(),
  coverage: z.number(),
  missing: z.number(),
  orphan: z.number(),
  stale: z.number(),
  errors: z.number(),
  warnings: z.number(),
};

interface CommonArgs {
  path?: string;
  localesDir?: string;
  source?: string;
  memory?: string;
  glossary?: string;
  limits?: string;
  ignoreIdentical?: string[];
  syntax?: string[];
}

function buildConfig(args: CommonArgs): Config {
  const config = detectProject(args.path ?? process.cwd(), {
    localesDir: args.localesDir,
    sourceLocale: args.source,
  });
  if (args.syntax && args.syntax.length > 0) config.placeholderSyntaxes = args.syntax;
  if (args.ignoreIdentical) config.ignoreIdentical = args.ignoreIdentical;
  return config;
}

/** An explicitly named memory must exist; the default path is optional. */
function openMemory(config: Config, explicit?: string): { memory: Memory | null; file: string } {
  const file = memoryPath(config.root, explicit);
  if (explicit && !existsSync(file)) throw new MemoryError(`Memory file not found: ${file}`);
  return { memory: loadMemory(file), file };
}

/** An explicitly named limits file must exist; the default path is optional. */
function openLimits(config: Config, explicit?: string): { limits: Limits | null; file: string } {
  const file = limitsPath(config.root, explicit);
  if (explicit && !existsSync(file)) throw new LimitsError(`Limits file not found: ${file}`);
  return { limits: loadLimits(file), file };
}

/** An explicitly named glossary must exist; the default path is optional. */
function openGlossary(config: Config, explicit?: string): { glossary: Glossary | null; file: string } {
  const file = glossaryPath(config.root, explicit);
  if (explicit && !existsSync(file)) throw new GlossaryError(`Glossary file not found: ${file}`);
  return { glossary: loadGlossary(file), file };
}

function pad(s: string, width: number, right = false): string {
  const gap = ' '.repeat(Math.max(0, width - s.length));
  return right ? gap + s : s + gap;
}

function renderTable(report: Report): string {
  const head = ['locale', 'cov', 'miss', 'orph'];
  if (report.memoryLoaded) head.push('stale');
  head.push('err', 'warn');

  const rows = report.stats.map((s) => {
    const row = [
      s.locale,
      `${(s.coverage * 100).toFixed(1)}%`,
      String(s.missing),
      String(s.orphan),
    ];
    if (report.memoryLoaded) row.push(String(s.stale));
    row.push(String(s.errors), String(s.warnings));
    return row;
  });

  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i]!, i > 0)).join('  ').trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

function renderFindings(findings: Finding[], offset: number, total: number): string {
  if (total === 0) return 'no findings';
  if (findings.length === 0) return `no findings at offset ${offset} (${total} total)`;

  const localeWidth = Math.max(...findings.map((f) => f.locale.length));
  const keyWidth = Math.max(...findings.map((f) => f.key.length));
  const ruleWidth = Math.max(...findings.map((f) => f.rule.length));

  const lines = findings.map(
    (f) =>
      `${f.severity === 'error' ? 'E' : 'W'} ${pad(f.locale, localeWidth)}  ` +
      `${pad(f.key, keyWidth)}  ${pad(f.rule, ruleWidth)}  ${f.detail}`,
  );

  const end = offset + findings.length;
  const header =
    end < total || offset > 0
      ? `findings ${offset + 1}-${end} of ${total} (raise offset for more)`
      : `findings (${total})`;

  return [header, ...lines].join('\n');
}

function describeError(err: unknown): string {
  if (
    err instanceof ScanError ||
    err instanceof MemoryError ||
    err instanceof GlossaryError ||
    err instanceof LimitsError
  ) {
    return err.message;
  }
  if (err instanceof FormatError) return describeFormatError(err);
  return err instanceof Error ? err.message : String(err);
}

function toolError(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: describeError(err) }] };
}

const server = new McpServer(
  { name: 'i18n-keeper', version: VERSION },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'i18n_scan',
  {
    title: 'Scan i18n project',
    description:
      'Report which locale directory, layout, locales and translation memory would be used. Run this first when the project layout is unknown.',
    inputSchema: commonInput,
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const config = buildConfig(args);
      const { layout, locales } = listLocales(config.localesDir);
      const { memory, file } = openMemory(config, args.memory);
      const glossaryInfo = openGlossary(config, args.glossary);
      const limitsInfo = openLimits(config, args.limits);
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `localesDir: ${config.localesDir}`,
              `layout: ${layout}`,
              `source: ${config.sourceLocale}`,
              `locales: ${locales.join(', ')}`,
              `placeholders: ${config.placeholderSyntaxes.join(', ')}`,
              `memory: ${memory ? file : 'none (run i18n_sync to start tracking)'}`,
              `glossary: ${
                glossaryInfo.glossary
                  ? `${glossaryInfo.file} (${glossaryInfo.glossary.terms.length} terms, ${glossaryInfo.glossary.doNotTranslate.length} verbatim)`
                  : 'none'
              }`,
              `limits: ${
                limitsInfo.limits
                  ? `${limitsInfo.file} (${Object.keys(limitsInfo.limits.keys).length} keys, ${limitsInfo.limits.patterns.length} patterns)`
                  : 'none'
              }`,
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  'i18n_status',
  {
    title: 'i18n coverage summary',
    description:
      'Per-locale coverage and issue counts, without listing individual findings. Cheap overview; use i18n_check for detail.',
    inputSchema: commonInput,
    outputSchema: {
      sourceLocale: z.string(),
      sourceKeys: z.number(),
      memoryLoaded: z.boolean(),
      locales: z.array(z.object(statShape)),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const config = buildConfig(args);
      const { memory } = openMemory(config, args.memory);
      const { glossary } = openGlossary(config, args.glossary);
      const { limits } = openLimits(config, args.limits);
      const report = check(config, memory, glossary, limits);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${report.sourceLocale} · ${report.sourceKeys} keys` +
              `${report.memoryLoaded ? '' : ' · no memory'}\n\n${renderTable(report)}`,
          },
        ],
        structuredContent: {
          sourceLocale: report.sourceLocale,
          sourceKeys: report.sourceKeys,
          memoryLoaded: report.memoryLoaded,
          locales: report.stats.map((s) => ({
            locale: s.locale,
            coverage: Number(s.coverage.toFixed(4)),
            missing: s.missing,
            orphan: s.orphan,
            stale: s.stale,
            errors: s.errors,
            warnings: s.warnings,
          })),
        },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  'i18n_check',
  {
    title: 'Lint locale files',
    description:
      'Find missing keys, orphans, empty values, structure mismatches, broken placeholders and — when a translation memory exists — translations whose source has changed since (stale). Deterministic: nothing is translated and no network is used. Filter by locale, rule or severity, and page with offset.',
    inputSchema: {
      ...commonInput,
      locale: z.array(z.string()).optional().describe('Only these target locales.'),
      rule: z
        .array(z.enum(RULE_IDS))
        .optional()
        .describe('Only these rules. Naming a rule also enables it if it is off by default.'),
      severity: z.enum(['error', 'warning']).optional().describe('Only this severity.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(`Findings per call (default ${DEFAULT_LIMIT}).`),
      offset: z.number().int().min(0).optional().describe('Skip this many findings.'),
      ignoreIdentical: z
        .array(z.string())
        .optional()
        .describe('Values allowed to equal the source, e.g. ["OK", "Email"].'),
      syntax: z
        .array(z.enum(ALL_SYNTAXES as [string, ...string[]]))
        .optional()
        .describe('Override placeholder syntaxes. Add "laravel" for :name projects.'),
      noMemory: z.boolean().optional().describe('Ignore the memory; disables stale detection.'),
      noGlossary: z.boolean().optional().describe('Ignore the glossary.'),
      noLimits: z.boolean().optional().describe('Ignore the width limits.'),
    },
    outputSchema: {
      sourceLocale: z.string(),
      sourceKeys: z.number(),
      memoryLoaded: z.boolean(),
      errors: z.number(),
      warnings: z.number(),
      total: z.number(),
      offset: z.number(),
      findings: z.array(
        z.object({
          rule: z.string(),
          severity: z.string(),
          locale: z.string(),
          key: z.string(),
          detail: z.string(),
        }),
      ),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const config = buildConfig(args);
      const rules = new Set((args.rule ?? []) as RuleId[]);
      // Naming a rule turns it on, so asking for an off-by-default rule works.
      for (const rule of rules) {
        if (config.rules[rule] === 'off') config.rules[rule] = 'warning';
      }

      const memory = args.noMemory ? null : openMemory(config, args.memory).memory;
      const glossary = args.noGlossary ? null : openGlossary(config, args.glossary).glossary;
      const limits = args.noLimits ? null : openLimits(config, args.limits).limits;
      const report = check(config, memory, glossary, limits);

      const locales = new Set(args.locale ?? []);
      let findings = report.findings;
      if (locales.size > 0) findings = findings.filter((f) => locales.has(f.locale));
      if (rules.size > 0) findings = findings.filter((f) => rules.has(f.rule));
      if (args.severity) findings = findings.filter((f) => f.severity === args.severity);

      const total = findings.length;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const page = findings.slice(offset, offset + limit);

      const errors = findings.filter((f) => f.severity === 'error').length;
      const stats =
        locales.size > 0 ? report.stats.filter((s) => locales.has(s.locale)) : report.stats;

      const text = [
        `${report.sourceLocale} · ${report.sourceKeys} keys · ${errors} errors · ${total - errors} warnings` +
          `${report.memoryLoaded ? '' : ' · no memory'}`,
        '',
        renderTable({ ...report, stats }),
        '',
        renderFindings(page, offset, total),
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: {
          sourceLocale: report.sourceLocale,
          sourceKeys: report.sourceKeys,
          memoryLoaded: report.memoryLoaded,
          errors,
          warnings: total - errors,
          total,
          offset,
          findings: page.map((f) => ({
            rule: f.rule,
            severity: f.severity,
            locale: f.locale,
            key: f.key,
            detail: f.detail,
          })),
        },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  'i18n_sync',
  {
    title: 'Record translations in the memory',
    description:
      'Write the current translations into .i18n/memory.json so later source edits can be detected as stale. Without force this never clears a stale flag: entries whose translation is unchanged keep their old source hash. Run it after translations are updated, and once when adopting the tool.',
    inputSchema: {
      ...commonInput,
      locale: z.array(z.string()).optional().describe('Only record these locales.'),
      origin: z
        .enum(['human', 'machine'])
        .optional()
        .describe('Who produced these translations. Default human, which also marks them reviewed.'),
      force: z
        .boolean()
        .optional()
        .describe('Re-record unchanged translations too, accepting them as current and clearing stale.'),
    },
    outputSchema: {
      memory: z.string(),
      created: z.number(),
      updated: z.number(),
      keptStale: z.number(),
      unchanged: z.number(),
      removed: z.number(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (args) => {
    try {
      const config = buildConfig(args);
      const file = memoryPath(config.root, args.memory);
      const memory = loadMemory(file) ?? emptyMemory(config.sourceLocale);
      const origin = args.origin ?? 'human';
      const result = syncMemory(config, memory, {
        origin,
        reviewed: origin === 'human',
        locales: args.locale,
        force: args.force === true,
      });
      saveMemory(file, memory);

      const note =
        result.keptStale > 0 && !args.force
          ? `\n${result.keptStale} translation(s) left stale on purpose — retranslate them, or sync with force to accept as-is.`
          : '';

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `memory ${file}\n` +
              `created ${result.created}  updated ${result.updated}  ` +
              `kept-stale ${result.keptStale}  unchanged ${result.unchanged}  removed ${result.removed}` +
              note,
          },
        ],
        structuredContent: { memory: file, ...result },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
