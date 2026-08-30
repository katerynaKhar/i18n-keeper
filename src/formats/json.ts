import { readFileSync } from 'node:fs';
import type { Leaf, LeafKind } from '../types.js';

export class ParseError extends Error {
  constructor(public file: string, message: string) {
    super(message);
  }
}

function kindOf(value: string | number | boolean | null): LeafKind {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function walk(
  node: unknown,
  prefix: string,
  file: string,
  leaves: Map<string, Leaf>,
  containers: Set<string>,
): void {
  if (node !== null && typeof node === 'object') {
    if (prefix) containers.add(prefix);
    const entries = Array.isArray(node)
      ? node.map((v, i) => [String(i), v] as const)
      : Object.entries(node as Record<string, unknown>);
    for (const [k, v] of entries) {
      walk(v, prefix ? `${prefix}.${k}` : k, file, leaves, containers);
    }
    return;
  }
  const value = node as string | number | boolean | null;
  leaves.set(prefix, { value: value === null ? '' : String(value), kind: kindOf(value), file });
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
  walk(parsed, namespace, file, leaves, containers);
}
