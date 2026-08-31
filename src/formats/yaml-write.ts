import { isAlias, isScalar, parseDocument } from 'yaml';
import { FormatError } from './error.js';
import { localeRootKey } from './yaml.js';
import type { Edit, WriteOutcome } from './write.js';

/**
 * YAML is the one format edited through a document model rather than by
 * splicing text, because the library keeps comments, anchors and node styles
 * across a round trip and a hand-rolled splicer would not.
 *
 * Two things are still done by hand. An existing scalar is mutated in place
 * instead of replaced, so a block scalar stays a block scalar and keeps its
 * comments. And an alias is refused outright: writing through `*shared` would
 * silently break every other key that shares the anchor.
 */
export function writeYamlLocale(
  content: string,
  file: string,
  locale: string,
  edits: Edit[],
): WriteOutcome {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new FormatError(file, doc.errors[0]!.message);
  }

  const root = localeRootKey(doc.toJS(), locale);
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const edit of edits) {
    const path = (root ? [root] : []).concat(edit.key.split('.'));
    const existing = doc.getIn(path, true);

    if (isAlias(existing)) {
      skipped.push({ key: edit.key, reason: 'the value is a YAML alias, shared with other keys' });
      continue;
    }
    if (isScalar(existing)) {
      // Keeps the node's style — block scalars stay block scalars.
      existing.value = edit.value;
      continue;
    }
    if (existing !== undefined && existing !== null) {
      skipped.push({ key: edit.key, reason: 'the key holds a collection, not a string' });
      continue;
    }

    doc.setIn(path, edit.value);
  }

  // lineWidth 0 disables re-wrapping, so untouched long lines stay as written.
  return { content: doc.toString({ lineWidth: 0 }), skipped };
}
