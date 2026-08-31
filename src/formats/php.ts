import { readFileSync } from 'node:fs';
import type { ReadTarget } from '../types.js';
import { FormatError } from './error.js';
import { flattenValue, type PlainValue } from './flatten.js';

/**
 * Parses the `<?php return [...];` subset that Laravel language files use.
 *
 * Deliberately a parser and not an evaluator: locale files come from the
 * repository being linted, so running them would mean executing untrusted code,
 * and it would force PHP onto every machine running the linter. Anything
 * outside the literal subset is a clear error rather than a guess.
 */

export class PhpParseError extends FormatError {
  constructor(file: string, line: number, message: string) {
    super(file, message, line);
  }
}

const IDENT_START = /[A-Za-z_\x80-￿]/;

/** Where a value sits in the source text, so it can be replaced in place. */
export interface ValueSpan {
  start: number;
  end: number;
}

/** `array(...)` still turns up in older projects; new entries should match. */
export type ArrayStyle = 'bracket' | 'array';

/** Where a new entry can be inserted into an existing array. */
export interface ArraySlot {
  style: ArrayStyle;
  /** Just past the last entry's value, or just past the opening bracket. */
  insertAt: number;
  /** Indentation the entries use, so an inserted one lines up. */
  indent: string;
  hasTrailingComma: boolean;
  empty: boolean;
}

export interface PhpLayout {
  /** Dot path -> the span of its value expression. */
  values: Map<string, ValueSpan>;
  /** Dot path of every array ('' for the returned one) -> where to insert. */
  arrays: Map<string, ArraySlot>;
}

class Parser {
  private pos = 0;
  readonly layout: PhpLayout = { values: new Map(), arrays: new Map() };

  constructor(
    private readonly text: string,
    private readonly file: string,
  ) {}

  /** The indentation of the line `at` sits on. */
  private indentAt(at: number): string {
    const lineStart = this.text.lastIndexOf('\n', at - 1) + 1;
    const match = /^[ \t]*/.exec(this.text.slice(lineStart, at));
    return match ? match[0] : '';
  }

  private lineAt(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos && i < this.text.length; i++) {
      if (this.text[i] === '\n') line++;
    }
    return line;
  }

  private error(message: string, pos = this.pos): never {
    throw new PhpParseError(this.file, this.lineAt(pos), message);
  }

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  /** Whitespace and all three PHP comment styles. */
  private skipTrivia(): void {
    for (;;) {
      while (!this.atEnd() && /\s/.test(this.text[this.pos]!)) this.pos++;

      if (this.text.startsWith('//', this.pos) || this.text.startsWith('#', this.pos)) {
        const nl = this.text.indexOf('\n', this.pos);
        this.pos = nl === -1 ? this.text.length : nl + 1;
        continue;
      }
      if (this.text.startsWith('/*', this.pos)) {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end === -1) this.error('Unterminated block comment');
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  private eat(token: string): boolean {
    this.skipTrivia();
    if (this.text.startsWith(token, this.pos)) {
      this.pos += token.length;
      return true;
    }
    return false;
  }

  private eatKeyword(word: string): boolean {
    this.skipTrivia();
    const slice = this.text.slice(this.pos, this.pos + word.length);
    if (slice.toLowerCase() !== word) return false;
    const next = this.text[this.pos + word.length];
    if (next !== undefined && /[\w]/.test(next)) return false;
    this.pos += word.length;
    return true;
  }

  private expect(token: string, what = token): void {
    if (!this.eat(token)) this.error(`Expected ${what}`);
  }

  parseFile(): PlainValue {
    const open = this.text.indexOf('<?php');
    if (open === -1) this.error('Missing <?php opening tag', 0);
    this.pos = open + '<?php'.length;

    // `declare(strict_types=1);` and similar preamble statements.
    while (this.eatKeyword('declare')) {
      const close = this.text.indexOf(')', this.pos);
      if (close === -1) this.error('Unterminated declare()');
      this.pos = close + 1;
      this.eat(';');
    }

    if (!this.eatKeyword('return')) {
      this.error('Expected `return` — a language file must return an array');
    }

    const value = this.parseValue('');
    this.expect(';');

    this.skipTrivia();
    if (this.eat('?>')) this.skipTrivia();
    if (!this.atEnd()) this.error('Unexpected content after the returned array');

    return value;
  }

  private parseValue(path: string): PlainValue {
    this.skipTrivia();
    if (this.atEnd()) this.error('Unexpected end of file');

    const ch = this.text[this.pos]!;

    if (ch === '[') {
      this.pos++;
      return this.parseArrayBody(']', path);
    }
    if (this.eatKeyword('array')) {
      this.expect('(', '( after array');
      return this.parseArrayBody(')', path);
    }
    if (ch === "'") return this.parseSingleQuoted();
    if (ch === '"') return this.parseDoubleQuoted();
    if (this.eatKeyword('true')) return true;
    if (this.eatKeyword('false')) return false;
    if (this.eatKeyword('null')) return null;
    if (/[-+\d.]/.test(ch)) return this.parseNumber();

    if (ch === '$') this.error('Variables are not supported in language files');
    if (this.text.startsWith('<<<', this.pos)) {
      this.error('Heredoc/nowdoc strings are not supported');
    }
    if (IDENT_START.test(ch)) this.error('Constants and function calls are not supported');

    this.error(`Unexpected character ${JSON.stringify(ch)}`);
  }

  private parseArrayBody(closing: string, path: string): PlainValue {
    const entries: Array<[string | number, PlainValue]> = [];
    let nextIndex = 0;
    let sawStringKey = false;

    const afterOpen = this.pos;
    let indent = '';
    let lastValueEnd = afterOpen;
    let hasTrailingComma = false;

    for (;;) {
      this.skipTrivia();
      if (this.eat(closing)) break;
      if (this.atEnd()) this.error(`Unterminated array, expected ${closing}`);

      const start = this.pos;
      if (indent === '') indent = this.indentAt(start);
      const first = this.parseValue(path);

      if (this.eat('=>')) {
        let key: string | number;
        if (typeof first === 'string') {
          sawStringKey = true;
          key = first;
        } else if (typeof first === 'number' && Number.isInteger(first)) {
          nextIndex = Math.max(nextIndex, first + 1);
          key = first;
        } else {
          this.error('Array keys must be strings or integers', start);
        }
        entries.push([key, this.recordValue(path, String(key))]);
      } else {
        const key = nextIndex++;
        // A list entry's value was already consumed as `first`; its span runs
        // from where the entry started to where parsing left off.
        this.layout.values.set(join(path, String(key)), { start, end: this.pos });
        entries.push([key, first]);
      }

      lastValueEnd = this.pos;
      this.skipTrivia();
      if (this.eat(',')) {
        hasTrailingComma = true;
        // Past the comma, so an inserted entry lands after it rather than
        // between the value and its separator.
        lastValueEnd = this.pos;
        continue;
      }
      hasTrailingComma = false;
      this.expect(closing, `, or ${closing}`);
      break;
    }

    this.layout.arrays.set(path, {
      style: closing === ')' ? 'array' : 'bracket',
      insertAt: entries.length === 0 ? afterOpen : lastValueEnd,
      indent: indent || '    ',
      hasTrailingComma,
      empty: entries.length === 0,
    });

    // PHP arrays are ordered maps; a purely sequential one is a JS array.
    const sequential =
      !sawStringKey && entries.every(([key], i) => typeof key === 'number' && key === i);
    if (sequential) return entries.map(([, value]) => value);

    const object: Record<string, PlainValue> = {};
    for (const [key, value] of entries) object[String(key)] = value;
    return object;
  }

  private recordValue(path: string, key: string): PlainValue {
    this.skipTrivia();
    const start = this.pos;
    const value = this.parseValue(join(path, key));
    this.layout.values.set(join(path, key), { start, end: this.pos });
    return value;
  }

  private parseNumber(): number {
    this.skipTrivia();
    const match = /^[-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?/.exec(
      this.text.slice(this.pos),
    );
    if (!match || match[0] === '') this.error('Malformed number');
    this.pos += match[0].length;
    return Number(match[0].replace(/_/g, ''));
  }

  /** Single quotes escape only \' and \\; everything else is literal. */
  private parseSingleQuoted(): string {
    const start = this.pos;
    this.pos++;
    let out = '';
    while (!this.atEnd()) {
      const ch = this.text[this.pos]!;
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        if (next === "'" || next === '\\') {
          out += next;
          this.pos += 2;
          continue;
        }
        out += ch;
        this.pos++;
        continue;
      }
      if (ch === "'") {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    this.error('Unterminated string', start);
  }

  private parseDoubleQuoted(): string {
    const start = this.pos;
    this.pos++;
    let out = '';
    while (!this.atEnd()) {
      const ch = this.text[this.pos]!;

      if (ch === '"') {
        this.pos++;
        return out;
      }

      if (ch === '$') {
        const next = this.text[this.pos + 1];
        if (next !== undefined && (IDENT_START.test(next) || next === '{')) {
          this.error('Variable interpolation is not supported in language files');
        }
        out += ch;
        this.pos++;
        continue;
      }

      if (ch === '{' && this.text[this.pos + 1] === '$') {
        this.error('Variable interpolation is not supported in language files');
      }

      if (ch === '\\') {
        out += this.readEscape();
        continue;
      }

      out += ch;
      this.pos++;
    }
    this.error('Unterminated string', start);
  }

  private readEscape(): string {
    const next = this.text[this.pos + 1];
    if (next === undefined) this.error('Unterminated escape sequence');

    const simple: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      f: '\f',
      e: '\x1b',
      '\\': '\\',
      $: '$',
      '"': '"',
    };
    if (next in simple) {
      this.pos += 2;
      return simple[next]!;
    }

    if (next === 'x') {
      const match = /^[0-9A-Fa-f]{1,2}/.exec(this.text.slice(this.pos + 2));
      if (match) {
        this.pos += 2 + match[0].length;
        return String.fromCharCode(Number.parseInt(match[0], 16));
      }
    }

    if (next === 'u' && this.text[this.pos + 2] === '{') {
      const close = this.text.indexOf('}', this.pos + 3);
      const hex = close === -1 ? '' : this.text.slice(this.pos + 3, close);
      if (close !== -1 && /^[0-9A-Fa-f]+$/.test(hex)) {
        this.pos = close + 1;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      this.error('Malformed \\u{...} escape');
    }

    const octal = /^[0-7]{1,3}/.exec(this.text.slice(this.pos + 1));
    if (octal) {
      this.pos += 1 + octal[0].length;
      return String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff);
    }

    // PHP keeps an unrecognised escape as a literal backslash plus the character.
    this.pos += 1;
    return '\\';
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export function parsePhp(text: string, file: string): PlainValue {
  return new Parser(text, file).parseFile();
}

/** Parses and also reports where every value and array sits in the text. */
export function parsePhpLayout(text: string, file: string): { value: PlainValue; layout: PhpLayout } {
  const parser = new Parser(text, file);
  const value = parser.parseFile();
  return { value, layout: parser.layout };
}

export function readPhpLocale(
  file: string,
  namespace: string,
  _locale: string,
  _isSource: boolean,
  target: ReadTarget,
): void {
  const parsed = parsePhp(readFileSync(file, 'utf8'), file);
  flattenValue(parsed, namespace, file, target.leaves, target.containers);
}
