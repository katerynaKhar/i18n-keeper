import { readFileSync } from 'node:fs';
import type { ReadTarget } from '../types.js';
import { FormatError } from './error.js';

/**
 * gettext .po / .pot.
 *
 * Two things make this format different from the others: the msgid *is* the
 * source text, so a .pot with empty translations is a usable source locale; and
 * the format already has a notion of an outdated translation — the fuzzy flag —
 * which maps onto the same rule the translation memory feeds.
 */

export class PoParseError extends FormatError {
  constructor(file: string, line: number, message: string) {
    super(file, message, line);
  }
}

export interface PoEntry {
  context: string | null;
  msgid: string;
  msgidPlural: string | null;
  msgstr: string[];
  fuzzy: boolean;
  line: number;
}

export interface PoFile {
  entries: PoEntry[];
  /** From the header's Plural-Forms, when present. */
  nplurals: number | null;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

function unescape(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) {
      out += ch;
      continue;
    }
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next]!;
      i++;
      continue;
    }
    if (next === 'x') {
      const hex = /^[0-9A-Fa-f]{1,2}/.exec(raw.slice(i + 2));
      if (hex) {
        out += String.fromCharCode(Number.parseInt(hex[0], 16));
        i += 1 + hex[0].length;
        continue;
      }
    }
    const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
    if (octal) {
      out += String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
      continue;
    }
    out += next;
    i++;
  }
  return out;
}

/** A quoted chunk, as it appears after a keyword or on a continuation line. */
function readQuoted(file: string, line: number, text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
    throw new PoParseError(file, line, 'Expected a quoted string');
  }
  return unescape(trimmed.slice(1, -1));
}

const KEYWORD = /^(msgctxt|msgid_plural|msgid|msgstr)(\[(\d+)\])?\s*(.*)$/;

export function parsePo(text: string, file: string): PoFile {
  const entries: PoEntry[] = [];
  const lines = text.split(/\r?\n/);

  // Assignments stay in the loop body rather than in closures, so the compiler
  // can follow whether an entry is open.
  let current: PoEntry | null = null;
  let field: 'msgctxt' | 'msgid' | 'msgid_plural' | null = null;
  let msgstrIndex: number | null = null;
  let fuzzy = false;
  let seenKeyword = false;

  for (const [index, rawLine] of lines.entries()) {
    const lineNo = index + 1;
    const line = rawLine.trim();

    // A blank line ends an entry; #~ marks one already removed from the
    // catalogue, so its block is dropped rather than parsed.
    if (line === '' || line.startsWith('#~')) {
      if (current && seenKeyword) entries.push(current);
      current = null;
      field = null;
      msgstrIndex = null;
      fuzzy = false;
      seenKeyword = false;
      continue;
    }

    if (line.startsWith('#')) {
      if (line.startsWith('#,')) {
        const flags = line
          .slice(2)
          .split(',')
          .map((f) => f.trim());
        if (flags.includes('fuzzy')) {
          fuzzy = true;
          if (current) current.fuzzy = true;
        }
      }
      continue;
    }

    const match = KEYWORD.exec(line);
    if (match) {
      if (!current) {
        current = { context: null, msgid: '', msgidPlural: null, msgstr: [], fuzzy, line: lineNo };
      }
      const entry = current;
      const keyword = match[1]!;
      seenKeyword = true;
      const value = readQuoted(file, lineNo, match[4] || '""');

      if (keyword === 'msgstr') {
        const at = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
        entry.msgstr[at] = value;
        msgstrIndex = at;
        field = null;
      } else if (keyword === 'msgctxt') {
        entry.context = value;
        field = 'msgctxt';
        msgstrIndex = null;
      } else if (keyword === 'msgid') {
        entry.msgid = value;
        field = 'msgid';
        msgstrIndex = null;
      } else {
        entry.msgidPlural = value;
        field = 'msgid_plural';
        msgstrIndex = null;
      }
      continue;
    }

    if (line.startsWith('"')) {
      if (!current) throw new PoParseError(file, lineNo, 'Continuation without a preceding keyword');
      const entry = current;
      const value = readQuoted(file, lineNo, line);
      if (msgstrIndex !== null) entry.msgstr[msgstrIndex] = (entry.msgstr[msgstrIndex] ?? '') + value;
      else if (field === 'msgctxt') entry.context = (entry.context ?? '') + value;
      else if (field === 'msgid') entry.msgid += value;
      else if (field === 'msgid_plural') entry.msgidPlural = (entry.msgidPlural ?? '') + value;
      else throw new PoParseError(file, lineNo, 'Continuation without a preceding keyword');
      continue;
    }

    throw new PoParseError(file, lineNo, `Unexpected line: ${line.slice(0, 40)}`);
  }

  if (current && seenKeyword) entries.push(current);

  let nplurals: number | null = null;
  const header = entries.find((e) => e.msgid === '' && e.context === null);
  if (header) {
    const declared = /nplurals\s*=\s*(\d+)/.exec(header.msgstr[0] ?? '');
    if (declared) nplurals = Number.parseInt(declared[1]!, 10);
  }

  return { entries: entries.filter((e) => e.msgid !== '' || e.context !== null), nplurals };
}

/** msgctxt disambiguates an otherwise identical msgid. */
export function poKey(entry: PoEntry): string {
  return entry.context === null ? entry.msgid : `${entry.context}|${entry.msgid}`;
}

export function readPoLocale(
  file: string,
  namespace: string,
  _locale: string,
  isSource: boolean,
  target: ReadTarget,
): void {
  const parsed = parsePo(readFileSync(file, 'utf8'), file);
  if (parsed.nplurals !== null) target.nplurals = parsed.nplurals;

  for (const entry of parsed.entries) {
    const base = namespace ? `${namespace}.${poKey(entry)}` : poKey(entry);

    if (entry.msgidPlural === null) {
      // In a template the translation is empty and the msgid carries the text.
      const value = isSource ? (entry.msgstr[0] || entry.msgid) : (entry.msgstr[0] ?? '');
      target.leaves.set(base, { value, kind: 'string', file, fuzzy: entry.fuzzy });
      continue;
    }

    const sourceForms = [entry.msgid, entry.msgidPlural];
    const count = Math.max(entry.msgstr.length, isSource ? sourceForms.length : 1);
    target.plurals.set(base, entry.msgstr.length);
    target.containers.add(base);

    for (let i = 0; i < count; i++) {
      const translated = entry.msgstr[i] ?? '';
      const value = isSource ? (translated || sourceForms[Math.min(i, 1)]!) : translated;
      target.leaves.set(`${base}.${i}`, { value, kind: 'string', file, fuzzy: entry.fuzzy });
    }
  }
}
