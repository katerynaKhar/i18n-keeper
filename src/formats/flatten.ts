import type { Leaf, LeafKind } from '../types.js';

export type PlainValue =
  | string
  | number
  | boolean
  | null
  | PlainValue[]
  | { [key: string]: PlainValue };

function kindOf(value: string | number | boolean | null): LeafKind {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

/** Flattens a parsed locale value into dot-notation keys, shared by every format. */
export function flattenValue(
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
      flattenValue(v, prefix ? `${prefix}.${k}` : k, file, leaves, containers);
    }
    return;
  }
  const value = node as string | number | boolean | null;
  leaves.set(prefix, { value: value === null ? '' : String(value), kind: kindOf(value), file });
}
