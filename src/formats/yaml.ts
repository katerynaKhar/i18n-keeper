import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ReadTarget } from '../types.js';
import { FormatError } from './error.js';
import { flattenValue } from './flatten.js';

/**
 * Rails and Symfony locale files.
 *
 * Unlike the PHP parser, this one delegates: reading YAML is not a security
 * question, and the spec is deep enough — anchors, block scalars, implicit
 * typing — that a hand-rolled subset would quietly misread real files.
 */

export class YamlParseError extends FormatError {}

function normaliseLocale(value: string): string {
  return value.toLowerCase().replace(/_/g, '-');
}

/**
 * Rails nests the whole file under its locale code. Left in place, every key in
 * en.yml would differ from every key in fr.yml.
 */
export function localeRootKey(parsed: unknown, locale: string): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1) return null;

  const root = keys[0]!;
  return normaliseLocale(root) === normaliseLocale(locale) ? root : null;
}

export function stripLocaleRoot(parsed: unknown, locale: string): unknown {
  const root = localeRootKey(parsed, locale);
  return root === null ? parsed : (parsed as Record<string, unknown>)[root];
}

export function readYamlLocale(
  file: string,
  namespace: string,
  locale: string,
  _isSource: boolean,
  target: ReadTarget,
): void {
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new YamlParseError(file, err instanceof Error ? err.message : String(err));
  }

  if (parsed === null || parsed === undefined) return; // an empty document

  const inner = stripLocaleRoot(parsed, locale);
  if (Array.isArray(inner)) {
    target.skipped.push({ file, reason: 'the file holds a list, not keyed translations' });
    return;
  }
  flattenValue(inner, namespace, file, target.leaves, target.containers);
}
