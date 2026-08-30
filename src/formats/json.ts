import { readFileSync } from 'node:fs';
import type { Leaf } from '../types.js';
import { flattenValue } from './flatten.js';

export class ParseError extends Error {
  constructor(
    public file: string,
    message: string,
  ) {
    super(message);
  }
}

/** Flattens one JSON locale file into dot-notation keys under an optional namespace. */
export function readJsonLocale(
  file: string,
  namespace: string,
  leaves: Map<string, Leaf>,
  containers: Set<string>,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ParseError(file, err instanceof Error ? err.message : String(err));
  }
  flattenValue(parsed, namespace, file, leaves, containers);
}
