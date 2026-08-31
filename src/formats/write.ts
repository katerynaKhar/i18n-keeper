/**
 * Writing back into a locale file.
 *
 * Reading throws away everything that is not a key or a value: comments,
 * quote styles, blank lines, anchors, translator notes. Writing must not, so
 * none of these writers re-serialise a parsed tree. They edit the text in
 * place — replacing the exact span of one value, or inserting one entry —
 * and leave every byte they did not have a reason to touch.
 */

export interface Edit {
  /** Key relative to this file, with any file-level namespace already removed. */
  key: string;
  value: string;
}

export interface WriteOutcome {
  content: string;
  /** Edits the format could not take, and why. */
  skipped: Array<{ key: string; reason: string }>;
}

export type LocaleWriter = (
  content: string,
  file: string,
  locale: string,
  edits: Edit[],
) => WriteOutcome;

/** Applies text edits from the end backwards, so earlier offsets stay valid. */
export function spliceAll(
  content: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = content;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
