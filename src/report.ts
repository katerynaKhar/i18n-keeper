import { relative } from 'node:path';
import type { Finding, Report } from './types.js';

const useColor =
  process.stdout.isTTY === true && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

const paint = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const yellow = paint('33');
const green = paint('32');

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = ' '.repeat(Math.max(0, width - s.length));
  return align === 'right' ? gap + s : s + gap;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function colorCoverage(value: number, text: string): string {
  if (value >= 0.99) return green(text);
  if (value >= 0.9) return yellow(text);
  return red(text);
}

function renderTable(report: Report): string[] {
  const headers = ['locale', 'coverage', 'missing', 'orphan', 'errors', 'warnings'];
  const rows = report.stats.map((s) => [
    s.locale,
    percent(s.coverage),
    String(s.missing),
    String(s.orphan),
    String(s.errors),
    String(s.warnings),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const align: Array<'left' | 'right'> = ['left', 'right', 'right', 'right', 'right', 'right'];

  const lines = [
    dim(headers.map((h, i) => pad(h, widths[i]!, align[i])).join('  ')),
  ];

  for (const [index, row] of rows.entries()) {
    const stat = report.stats[index]!;
    const cells = row.map((cell, i) => {
      const text = pad(cell ?? '', widths[i]!, align[i]);
      if (i === 1) return colorCoverage(stat.coverage, text);
      if (i === 4 && stat.errors > 0) return red(text);
      if (i === 5 && stat.warnings > 0) return yellow(text);
      return text;
    });
    lines.push(cells.join('  '));
  }

  return lines;
}

function renderFindings(findings: Finding[], root: string, limit: number): string[] {
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
        [
          pad(f.locale, localeWidth),
          pad(key, keyWidth),
          dim(pad(f.rule, ruleWidth)),
          f.detail,
        ].join('  '),
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

  const lines = [
    `${bold('i18n check')} ${dim('·')} source: ${bold(report.sourceLocale)} ${dim('·')} ${report.sourceKeys} keys ${dim('·')} ${dim(relative(root, report.localesDir) || report.localesDir)}`,
    '',
    ...renderTable(report),
    ...renderFindings(report.findings, root, limit),
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
