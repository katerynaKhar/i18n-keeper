import { relative } from 'node:path';
import type { Finding, LocaleStat, Report } from './types.js';

const useColor =
  process.stdout.isTTY === true && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

const paint = (code: string) => (s: string) =>
  useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const yellow = paint('33');
const green = paint('32');

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = ' '.repeat(Math.max(0, width - s.length));
  return align === 'right' ? gap + s : s + gap;
}

function colorCoverage(value: number, text: string): string {
  if (value >= 0.99) return green(text);
  if (value >= 0.9) return yellow(text);
  return red(text);
}

interface Column {
  header: string;
  align: 'left' | 'right';
  value: (s: LocaleStat) => string;
  color?: (s: LocaleStat, text: string) => string;
}

function columns(report: Report): Column[] {
  const cols: Column[] = [
    { header: 'locale', align: 'left', value: (s) => s.locale },
    {
      header: 'coverage',
      align: 'right',
      value: (s) => `${(s.coverage * 100).toFixed(1)}%`,
      color: (s, text) => colorCoverage(s.coverage, text),
    },
    { header: 'missing', align: 'right', value: (s) => String(s.missing) },
    { header: 'orphan', align: 'right', value: (s) => String(s.orphan) },
  ];

  // Without a translation memory there is nothing to compare against, so the
  // column would only ever print zeroes.
  if (report.memoryLoaded) {
    cols.push({
      header: 'stale',
      align: 'right',
      value: (s) => String(s.stale),
      color: (s, text) => (s.stale > 0 ? yellow(text) : text),
    });
  }

  cols.push(
    {
      header: 'errors',
      align: 'right',
      value: (s) => String(s.errors),
      color: (s, text) => (s.errors > 0 ? red(text) : text),
    },
    {
      header: 'warnings',
      align: 'right',
      value: (s) => String(s.warnings),
      color: (s, text) => (s.warnings > 0 ? yellow(text) : text),
    },
  );

  return cols;
}

function renderTable(report: Report): string[] {
  const cols = columns(report);
  const cells = report.stats.map((s) => cols.map((c) => c.value(s)));
  const widths = cols.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => (row[i] ?? '').length)),
  );

  const lines = [dim(cols.map((c, i) => pad(c.header, widths[i]!, c.align)).join('  '))];

  for (const [rowIndex, row] of cells.entries()) {
    const stat = report.stats[rowIndex]!;
    lines.push(
      cols
        .map((c, i) => {
          const text = pad(row[i] ?? '', widths[i]!, c.align);
          return c.color ? c.color(stat, text) : text;
        })
        .join('  '),
    );
  }

  return lines;
}

function renderFindings(findings: Finding[], limit: number): string[] {
  if (findings.length === 0) return [];

  const shown = findings.slice(0, limit);
  const localeWidth = Math.max(...shown.map((f) => f.locale.length));
  const keyWidth = Math.min(36, Math.max(...shown.map((f) => f.key.length)));
  const ruleWidth = Math.max(...shown.map((f) => f.rule.length));

  const lines: string[] = [];
  let lastSeverity = '';

  for (const f of shown) {
    if (f.severity !== lastSeverity) {
      lines.push('');
      lines.push(f.severity === 'error' ? red(bold('errors')) : yellow(bold('warnings')));
      lastSeverity = f.severity;
    }
    const key = f.key.length > keyWidth ? `…${f.key.slice(-(keyWidth - 1))}` : f.key;
    lines.push(
      '  ' +
        [pad(f.locale, localeWidth), pad(key, keyWidth), dim(pad(f.rule, ruleWidth)), f.detail].join(
          '  ',
        ),
    );
  }

  if (findings.length > shown.length) {
    lines.push(dim(`  … ${findings.length - shown.length} more (use --limit)`));
  }

  return lines;
}

export function renderReport(report: Report, root: string, limit: number): string {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.length - errors;

  const head = [
    `${bold('i18n check')}`,
    `source: ${bold(report.sourceLocale)}${report.sourceFromMsgid ? dim(' (msgid)') : ''}`,
    `${report.sourceKeys} keys`,
    dim(relative(root, report.localesDir) || report.localesDir),
  ];
  if (!report.memoryLoaded) head.push(dim('no memory'));

  const lines = [
    head.join(` ${dim('·')} `),
    '',
    ...renderTable(report),
    ...renderFindings(report.findings, limit),
    '',
  ];

  if (report.findings.length === 0) {
    lines.push(green('✓ no issues'));
  } else {
    const parts = [];
    if (errors > 0) parts.push(red(`${errors} error${errors === 1 ? '' : 's'}`));
    if (warnings > 0) parts.push(yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`));
    lines.push(parts.join(dim(' · ')));
  }

  return lines.join('\n');
}
