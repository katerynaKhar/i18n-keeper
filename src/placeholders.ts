/**
 * Placeholder extraction across the interpolation syntaxes that actually collide
 * in the wild. Patterns are applied in a fixed order and every match is masked
 * out of the working copy, so `{{name}}` is never also counted as `{name}`.
 */

interface PatternSpec {
  re: RegExp;
  label: (m: RegExpExecArray) => string;
}

const PATTERNS: Record<string, PatternSpec> = {
  // {{ name }} — mustache / i18next default
  mustache: {
    re: /\{\{\s*[#/^&]?\s*([\w.$-]+)\s*\}\}/g,
    label: (m) => `{{${m[1]}}}`,
  },
  // %{name} — ruby i18n
  ruby: {
    re: /%\{\s*([\w.$-]+)\s*\}/g,
    label: (m) => `%{${m[1]}}`,
  },
  // {count, plural, ...} — ICU complex argument; matched by its head so that
  // nested braces in the sub-messages do not hide the argument name.
  icu_complex: {
    re: /\{\s*([\w.$-]+)\s*,\s*(plural|select|selectordinal|number|date|time)\b/g,
    label: (m) => `{${m[1]},${m[2]}}`,
  },
  // {name} — ICU simple argument
  icu: {
    re: /\{\s*([\w.$-]+)\s*\}/g,
    label: (m) => `{${m[1]}}`,
  },
  // %s, %d, %1$s — printf
  printf: {
    re: /%(?:(\d+)\$)?([sdifux])/g,
    label: (m) => (m[1] ? `%${m[1]}$${m[2]}` : `%${m[2]}`),
  },
  // <0>...</0> — react-i18next <Trans> indices
  tag: {
    re: /<\/?(\d+)>/g,
    label: (m) => m[0],
  },
  // :name — Laravel. Off by default: it false-positives on prose like
  // "Warning:Important". Enable per project once the format is known.
  laravel: {
    re: /(?<![\w:]):([a-zA-Z][\w]*)/g,
    label: (m) => `:${m[1]}`,
  },
};

/** Longest / most specific syntaxes first, so masking works. */
const ORDER = ['mustache', 'ruby', 'icu_complex', 'icu', 'printf', 'tag', 'laravel'];

export const DEFAULT_SYNTAXES = ['mustache', 'ruby', 'icu_complex', 'icu', 'printf', 'tag'];
export const ALL_SYNTAXES = ORDER;

const MASK = '\u0000';

function maskSpans(text: string, spans: Array<[number, number]>): string {
  const chars = [...text];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = MASK;
  }
  return chars.join('');
}

/** Returns a multiset of placeholder labels: `{name}` twice is not the same as once. */
export function extractPlaceholders(text: string, syntaxes: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  let masked = text;

  for (const id of ORDER) {
    if (!syntaxes.includes(id)) continue;
    const spec = PATTERNS[id];
    if (!spec) continue;

    const re = new RegExp(spec.re.source, spec.re.flags);
    const spans: Array<[number, number]> = [];
    let m: RegExpExecArray | null;

    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const label = spec.label(m);
      counts.set(label, (counts.get(label) ?? 0) + 1);
      spans.push([m.index, m.index + m[0].length]);
    }

    if (spans.length > 0) masked = maskSpans(masked, spans);
  }

  return counts;
}

export interface PlaceholderDiff {
  missing: string[];
  extra: string[];
}

/** What the target lost from the source, and what it invented. */
export function diffPlaceholders(
  source: Map<string, number>,
  target: Map<string, number>,
): PlaceholderDiff {
  const missing: string[] = [];
  const extra: string[] = [];

  for (const [label, count] of source) {
    const got = target.get(label) ?? 0;
    if (got < count) missing.push(count - got > 1 ? `${label} x${count - got}` : label);
  }
  for (const [label, count] of target) {
    const had = source.get(label) ?? 0;
    if (count > had) extra.push(count - had > 1 ? `${label} x${count - had}` : label);
  }

  return { missing, extra };
}
