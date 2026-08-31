import { parsePhpLayout, type ArraySlot, type ArrayStyle } from './php.js';
import { spliceAll, type Edit, type WriteOutcome } from './write.js';

/** Nested levels that have to be created get this much extra indentation. */
const INDENT_STEP = '    ';

const SHORT_ESCAPES = new Map<number, string>([
  [0x0a, '\\n'],
  [0x0d, '\\r'],
  [0x09, '\\t'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x1b, '\\e'],
]);

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    if (ch.codePointAt(0)! < 0x20) return true;
  }
  return false;
}

/**
 * A PHP string literal for an arbitrary value.
 *
 * Single quotes are preferred because nothing interpolates inside them: `$` and
 * Laravel's `:name` stay literal, which is exactly what a language file wants.
 * Control characters have no single-quoted spelling, so those fall back to
 * double quotes with escapes.
 */
export function phpLiteral(value: string): string {
  if (!hasControlCharacter(value)) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20) {
      if (ch === '\\' || ch === '"' || ch === '$') out += `\\${ch}`;
      else out += ch;
      continue;
    }
    out += SHORT_ESCAPES.get(cp) ?? `\\x${cp.toString(16).padStart(2, '0')}`;
  }
  return `"${out}"`;
}

const OPEN: Record<ArrayStyle, string> = { bracket: '[', array: 'array(' };
const CLOSE: Record<ArrayStyle, string> = { bracket: ']', array: ')' };

/** `'a' => ['b' => 'value'],` for however many levels are missing. */
function nestedEntry(keys: string[], value: string, indent: string, style: ArrayStyle): string {
  const [head, ...rest] = keys;
  if (rest.length === 0) return `${indent}${phpLiteral(head!)} => ${phpLiteral(value)},`;
  return [
    `${indent}${phpLiteral(head!)} => ${OPEN[style]}`,
    nestedEntry(rest, value, indent + INDENT_STEP, style),
    `${indent}${CLOSE[style]},`,
  ].join('\n');
}

/**
 * An empty language file shaped like the one it is being translated from, so a
 * project written with `array()` does not suddenly gain a file that is not.
 */
export function blankPhpFile(sourceContent: string | null): string {
  let style: ArrayStyle = 'bracket';
  if (sourceContent !== null) {
    try {
      style = parsePhpLayout(sourceContent, '<source>').layout.arrays.get('')?.style ?? 'bracket';
    } catch {
      // An unreadable source is no reason to refuse to create the target.
    }
  }
  return `<?php\n\nreturn ${OPEN[style]}\n${CLOSE[style]};\n`;
}

/** The deepest array that already exists on the way to `key`. */
function parentFor(
  arrays: Map<string, ArraySlot>,
  key: string,
): { slot: ArraySlot; remaining: string[] } | null {
  const parts = key.split('.');
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const slot = arrays.get(parts.slice(0, depth).join('.'));
    if (slot) return { slot, remaining: parts.slice(depth) };
  }
  return null;
}

export function writePhpLocale(
  content: string,
  file: string,
  _locale: string,
  edits: Edit[],
): WriteOutcome {
  const { layout } = parsePhpLayout(content, file);
  const skipped: Array<{ key: string; reason: string }> = [];
  const splices: Array<{ start: number; end: number; text: string }> = [];

  // Several new keys can belong in the same array and share one insertion
  // point, so they are collected and emitted together, in order.
  const insertions = new Map<number, { slot: ArraySlot; lines: string[] }>();

  for (const edit of edits) {
    const span = layout.values.get(edit.key);
    if (span) {
      splices.push({ start: span.start, end: span.end, text: phpLiteral(edit.value) });
      continue;
    }

    if (layout.arrays.has(edit.key)) {
      skipped.push({ key: edit.key, reason: 'the key holds an array, not a string' });
      continue;
    }

    const parent = parentFor(layout.arrays, edit.key);
    if (!parent) {
      skipped.push({ key: edit.key, reason: 'no array to insert into' });
      continue;
    }

    const entry = nestedEntry(parent.remaining, edit.value, parent.slot.indent, parent.slot.style);
    const bucket = insertions.get(parent.slot.insertAt);
    if (bucket) bucket.lines.push(entry);
    else insertions.set(parent.slot.insertAt, { slot: parent.slot, lines: [entry] });
  }

  for (const [at, { slot, lines }] of insertions) {
    const body = lines.join('\n');
    // An empty array usually already has a newline before its closing bracket;
    // adding a second one would leave a blank line in the file.
    const closingOnNextLine = content.slice(at).startsWith('\n');
    const text = slot.empty
      ? closingOnNextLine
        ? `\n${body}`
        : `\n${body}\n`
      : slot.hasTrailingComma
        ? `\n${body}`
        : `,\n${body}`;
    splices.push({ start: at, end: at, text });
  }

  return { content: spliceAll(content, splices), skipped };
}
