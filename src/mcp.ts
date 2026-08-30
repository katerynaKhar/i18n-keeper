#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { check } from './check.js';
import { ParseError } from './formats/json.js';
import { ALL_SYNTAXES } from './placeholders.js';
import { ScanError, detectProject, listLocales } from './scan.js';
import { RULE_IDS, type Config, type Finding, type Report, type RuleId } from './types.js';

/**
 * Everything a tool returns lands in the agent's context, so the text stays
 * compact and findings are paged rather than dumped.
 */
const DEFAULT_LIMIT = 25;

const commonInput = {
  path: z.string().optional().describe('Project root. Defaults to the working directory.'),
  localesDir: z.string().optional().describe('Locales directory. Auto-detected when omitted.'),
  source: z.string().optional().describe('Source locale. Defaults to en, else the first found.'),
};

const statShape = {
  locale: z.string(),
  coverage: z.number(),
  missing: z.number(),
  orphan: z.number(),
  errors: z.number(),
  warnings: z.number(),
};

function buildConfig(args: {
  path?: string;
  localesDir?: string;
  source?: string;
  ignoreIdentical?: string[];
  syntax?: string[];
}): Config {
  const config = detectProject(args.path ?? process.cwd(), {
    localesDir: args.localesDir,
    sourceLocale: args.source,
  });
  if (args.syntax && args.syntax.length > 0) config.placeholderSyntaxes = args.syntax;
  if (args.ignoreIdentical) config.ignoreIdentical = args.ignoreIdentical;
  return config;
}

function pad(s: string, width: number, right = false): string {
  const gap = ' '.repeat(Math.max(0, width - s.length));
  return right ? gap + s : s + gap;
}

function renderTable(report: Report): string {
  const head = ['locale', 'cov', 'miss', 'orph', 'err', 'warn'];
  const rows = report.stats.map((s) => [
    s.locale,
    `${(s.coverage * 100).toFixed(1)}%`,
    String(s.missing),
    String(s.orphan),
    String(s.errors),
    String(s.warnings),
  ]);
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

function toolError(err: unknown) {
  const message =
    err instanceof ScanError
      ? err.message
      : err instanceof ParseError
        ? `Invalid JSON in ${err.file}\n  ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer(
  { name: 'i18n-keeper', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'i18n_scan',
  {
    title: 'Scan i18n project',
    description:
      'Report which locale directory, layout and locales would be checked. Run this first when the project layout is unknown.',
    inputSchema: commonInput,
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const config = buildConfig(args);
      const { layout, locales } = listLocales(config.localesDir);
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
      locales: z.array(z.object(statShape)),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const report = check(buildConfig(args));
      const structuredContent = {
        sourceLocale: report.sourceLocale,
        sourceKeys: report.sourceKeys,
        locales: report.stats.map((s) => ({
          locale: s.locale,
          coverage: Number(s.coverage.toFixed(4)),
          missing: s.missing,
          orphan: s.orphan,
          errors: s.errors,
          warnings: s.warnings,
        })),
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: `${report.sourceLocale} · ${report.sourceKeys} keys\n\n${renderTable(report)}`,
          },
        ],
        structuredContent,
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
      'Find missing keys, orphans, empty values, structure mismatches and broken placeholders across locales. Deterministic: nothing is translated and no network is used. Filter by locale, rule or severity, and page with offset.',
    inputSchema: {
      ...commonInput,
      locale: z.array(z.string()).optional().describe('Only these target locales.'),
      rule: z.array(z.enum(RULE_IDS)).optional().describe('Only these rules.'),
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
    },
    outputSchema: {
      sourceLocale: z.string(),
      sourceKeys: z.number(),
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
      const report = check(config);

      const locales = new Set(args.locale ?? []);
      const rules = new Set((args.rule ?? []) as RuleId[]);
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
        `${report.sourceLocale} · ${report.sourceKeys} keys · ${errors} errors · ${total - errors} warnings`,
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

await server.connect(new StdioServerTransport());
