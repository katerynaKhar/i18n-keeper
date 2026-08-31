import { readFileSync } from 'node:fs';
import type { ReadTarget } from '../types.js';
import { FormatError } from './error.js';
import { flattenValue } from './flatten.js';

export class ParseError extends FormatError {}

/** Flattens one JSON locale file into dot-notation keys under an optional namespace. */
export function readJsonLocale(
  file: string,
  namespace: string,
  _locale: string,
  _isSource: boolean,
  target: ReadTarget,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ParseError(file, err instanceof Error ? err.message : String(err));
  }
  if (Array.isArray(parsed)) {
    target.skipped.push({ file, reason: 'the file holds a list, not keyed translations' });
    return;
  }
  flattenValue(parsed, namespace, file, target.leaves, target.containers);
}
