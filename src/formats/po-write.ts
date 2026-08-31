import { poKey, parsePo } from './po.js';
import type { Edit, WriteOutcome } from './write.js';

/**
 * gettext catalogues, edited line by line.
 *
 * One deliberate choice beyond preserving the file: a translation written here
 * is marked `#, fuzzy`. That flag is gettext's own word for "not reviewed by a
 * person yet", which is exactly what this tool records as `reviewed: false` in
 * the memory. Leaving it off would claim a human had approved the string.
 * It does mean `check` then reports those entries as stale — correctly.
 */

const ESCAPES = new Map<number, string>([
  [0x0a, '\\n'],
  [0x0d, '\\r'],
  [0x09, '\\t'],
]);

export function poString(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '"') out += `\\${ch}`;
    else if (cp < 0x20) out += ESCAPES.get(cp) ?? `\\x${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

interface Block {
  /** Index of the `#,` flag line, if the entry has one. */
  flagLine: number | null;
  /** First line of the entry proper, where a flag line can go before it. */
  headLine: number;
  /** msgstr index -> the lines it occupies, [start, end). */
  msgstr: Map<number, { start: number; end: number }>;
  /** True for the catalogue header, which carries no translation. */
  headerLike: boolean;
}

const KEYWORD = /^(msgctxt|msgid_plural|msgid|msgstr)(?:\[(\d+)\])?(.*)$/;
const EMPTY_STRING = /^\s*""\s*$/;

/**
 * Lines up each entry in the text with the key the parser resolved for it.
 *
 * The parser drops the header entry, so the scanner has to drop it too or every
 * key lands one entry early — which is exactly the bug this shape prevents.
 */
function scan(content: string, file: string): { lines: string[]; blocks: Map<string, Block> } {
  const lines = content.split(/\r?\n/);
  const keysInOrder = parsePo(content, file).entries.map(poKey);
  const blocks = new Map<string, Block>();

  let current: Block | null = null;
  let msgidEmpty = true;
  let inMsgid = false;
  let lastMsgstr: number | null = null;
  let obsolete = false;
  let entryIndex = 0;

  const close = (): void => {
    if (current && current.msgstr.size > 0 && !obsolete) {
      current.headerLike = msgidEmpty;
      if (!msgidEmpty) {
        const key = keysInOrder[entryIndex];
        if (key !== undefined) blocks.set(key, current);
        entryIndex++;
      }
    }
    current = null;
    msgidEmpty = true;
    inMsgid = false;
    lastMsgstr = null;
    obsolete = false;
  };

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    if (line === '') {
      close();
      continue;
    }
    if (line.startsWith('#~')) {
      obsolete = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#,')) {
        current ??= { flagLine: null, headLine: index, msgstr: new Map(), headerLike: false };
        current.flagLine = index;
      }
      continue;
    }

    const match = KEYWORD.exec(line);
    if (match) {
      if (!current) current = { flagLine: null, headLine: index, msgstr: new Map(), headerLike: false };
      else if (current.msgstr.size === 0 && current.flagLine === null) {
        current.headLine = Math.min(current.headLine, index);
      }

      if (match[1] === 'msgstr') {
        const at = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
        current.msgstr.set(at, { start: index, end: index + 1 });
        lastMsgstr = at;
        inMsgid = false;
      } else {
        if (match[1] === 'msgid') {
          inMsgid = true;
          msgidEmpty = EMPTY_STRING.test(match[3] ?? '');
        } else {
          inMsgid = false;
        }
        lastMsgstr = null;
      }
      continue;
    }

    if (line.startsWith('"') && current) {
      if (lastMsgstr !== null) {
        current.msgstr.get(lastMsgstr)!.end = index + 1;
      } else if (inMsgid && !EMPTY_STRING.test(line)) {
        // A msgid spelled across continuation lines is not the empty header.
        msgidEmpty = false;
      }
    }
  }
  close();

  return { lines, blocks };
}

function splitForm(key: string): { base: string; form: number | null } {
  const match = /^(.*)\.(\d+)$/.exec(key);
  return match
    ? { base: match[1]!, form: Number.parseInt(match[2]!, 10) }
    : { base: key, form: null };
}

/**
 * A new entry has to be spelled back out as msgctxt + msgid. The key format
 * joins them with `|`, which a msgid could itself contain; splitting at the
 * first one matches how the key was built and is wrong only for a contextless
 * msgid that happens to contain a pipe.
 */
function appendEntry(key: string, value: string): string[] {
  const pipe = key.indexOf('|');
  const head =
    pipe > 0
      ? [`msgctxt ${poString(key.slice(0, pipe))}`, `msgid ${poString(key.slice(pipe + 1))}`]
      : [`msgid ${poString(key)}`];
  return ['', '#, fuzzy', ...head, `msgstr ${poString(value)}`];
}

export function writePoLocale(
  content: string,
  file: string,
  _locale: string,
  edits: Edit[],
): WriteOutcome {
  const { lines, blocks } = scan(content, file);
  const skipped: Array<{ key: string; reason: string }> = [];

  // line index -> replacement lines, or null to drop the line.
  const replaced = new Map<number, string[] | null>();
  const needFuzzy = new Set<Block>();
  const appended: string[] = [];

  for (const edit of edits) {
    let block = blocks.get(edit.key);
    let form = 0;

    if (!block) {
      const split = splitForm(edit.key);
      if (split.form !== null) {
        const candidate = blocks.get(split.base);
        if (candidate) {
          block = candidate;
          form = split.form;
        }
      }
    }

    if (!block) {
      appended.push(...appendEntry(edit.key, edit.value));
      continue;
    }

    const span = block.msgstr.get(form);
    if (!span) {
      skipped.push({ key: edit.key, reason: `the entry has no msgstr[${form}]` });
      continue;
    }

    const label = block.msgstr.size > 1 ? `msgstr[${form}]` : 'msgstr';
    replaced.set(span.start, [`${label} ${poString(edit.value)}`]);
    for (let line = span.start + 1; line < span.end; line++) replaced.set(line, null);
    needFuzzy.add(block);
  }

  for (const block of needFuzzy) {
    if (block.flagLine !== null) {
      const flags = lines[block.flagLine]!;
      if (!/\bfuzzy\b/.test(flags)) replaced.set(block.flagLine, [`${flags}, fuzzy`]);
      continue;
    }
    const head: string[] = replaced.get(block.headLine) ?? [lines[block.headLine]!];
    replaced.set(block.headLine, ['#, fuzzy', ...head]);
  }

  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const replacement = replaced.get(index);
    if (replacement === undefined) out.push(line);
    else if (replacement !== null) out.push(...replacement);
  }

  if (appended.length > 0) {
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    out.push(...appended, '');
  }

  // A catalogue checked out on Windows may use CRLF; writing back with bare
  // newlines would leave the file mixed.
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return { content: out.join(newline), skipped };
}
