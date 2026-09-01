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
  // "Warning:Important". Enabled automatically for PHP locale files.
  // Laravel treats :name, :Name and :NAME as one placeholder rendered with
  // different capitalisation, so they normalise to one label here.
  laravel: {
    re: /(?<![\w:]):([a-zA-Z][\w]*)/g,
    label: (m) => `:${m[1]!.toLowerCase()}`,
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

/**
 * Laravel substitutes with `strtr()`, which needs no word boundary, so a
 * translation may glue a suffix straight onto the token and still render: the
 * Somali definite article in `:attributeka`, the Amharic one in `:attributeቱ`.
 * The greedy pattern above reads the whole run as the name, which reports one
 * correct string as both a lost `:attribute` and an invented `:attributeka`.
 *
 * When the names the source actually offers are known, the match is cut back to
 * the longest of them it starts with — the same choice `strtr` makes.
 */
function knownNames(known: Iterable<string> | undefined): Set<string> | null {
  if (!known) return null;
  const names = new Set<string>();
  for (const label of known) {
    const name = label.replace(/^:/, '').toLowerCase();
    if (/^[a-z][\w]*$/.test(name)) names.add(name);
  }
  return names.size > 0 ? names : null;
}

/**
 * `strtr` needs no boundary on either side, so Shona's `ne:terms_of_service`
 * substitutes just as well as a token standing alone. The guarded pattern above
 * cannot see it. This one is used only when the source names are known, so that
 * anything it turns up can still be required to be one of them.
 */
const LARAVEL_ANYWHERE = /:([a-zA-Z][\w]*)/g;

function longestKnownPrefix(identifier: string, names: Set<string>): string | null {
  const lower = identifier.toLowerCase();
  let best: string | null = null;
  for (const name of names) {
    if (lower.startsWith(name) && (best === null || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * Returns a multiset of placeholder labels: `{name}` twice is not the same as once.
 *
 * `known` carries the labels found in the source string. It only affects the
 * Laravel syntax, where the boundary of a name cannot be read off the target
 * text alone.
 */
export function extractPlaceholders(
  text: string,
  syntaxes: string[],
  known?: Iterable<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const laravelNames = knownNames(known);
  let masked = text;

  for (const id of ORDER) {
    if (!syntaxes.includes(id)) continue;
    const spec = PATTERNS[id];
    if (!spec) continue;

    const permissive = id === 'laravel' && laravelNames !== null;
    const re = new RegExp(permissive ? LARAVEL_ANYWHERE.source : spec.re.source, spec.re.flags);
    const spans: Array<[number, number]> = [];
    let m: RegExpExecArray | null;

    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      let label = spec.label(m);
      if (permissive) {
        const name = longestKnownPrefix(m[1]!, laravelNames!);
        if (name !== null) {
          label = `:${name}`;
        } else if (/[\w:]/.test(masked[m.index - 1] ?? '')) {
          // Not a name the source offers, and glued to the word before it:
          // prose like "Warning:Important", not a placeholder.
          continue;
        }
      }
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
