# i18n-keeper

Deterministic linter for locale files. No LLM, no network, no API key — every
finding is mechanically verifiable, which is the point: you can trust the report
in languages you do not read.

```bash
npx i18n-keeper check
```

```
i18n check · source: en · 16 keys · locales

locale  coverage  missing  orphan  errors  warnings
de         93.8%        0       0       1         0
es        100.0%        0       1       0         3
fr         93.8%        1       0       2         1
pl         68.8%        4       0       8         1

errors
  de  nav.home       structure_mismatch   value in source, object in target
  fr  cart.total     placeholder_missing  {{amount}} lost
  pl  order.thanks   placeholder_extra    {{imie}} not in source
  ...
```

## Rules

| Rule | Default | What it catches |
|---|---|---|
| `missing_key` | error | Key in the source locale, absent in a target |
| `empty_value` | error | Key present but the string is empty |
| `structure_mismatch` | error | Value on one side, object on the other |
| `placeholder_missing` | error | `{{name}}`, `%s`, `<0>` dropped in translation |
| `placeholder_extra` | error | Placeholder that does not exist in the source |
| `orphan_key` | warning | Key in a target locale, gone from the source |
| `identical_to_source` | warning | Probably untranslated (allowlist with `--ignore-identical`) |

Errors break at runtime. Warnings only look bad.

## Placeholder syntaxes

Detected by default: `{{name}}` (mustache/i18next), `{name}` and
`{count, plural, ...}` (ICU), `%{name}` (Ruby), `%s` / `%1$s` (printf),
`<0>…</0>` (react-i18next `<Trans>`).

Patterns are applied most-specific first and each match is masked out, so
`{{name}}` is never also counted as `{name}`.

Laravel's `:name` is available via `--syntax` but off by default — it
false-positives on prose like `Warning:Important`.

## Layouts

Both are auto-detected:

```
locales/en.json              locales/en/common.json
locales/fr.json              locales/en/shop/pricing.json  -> shop.pricing.price
```

## Usage

```
i18n-keeper check [path]    lint locale files
i18n-keeper scan  [path]    show what would be checked

--locales <dir>             locales directory (default: auto-detect)
--source <locale>           source locale (default: en, else the first found)
--locale <locale>           only report this target locale (repeatable)
--rule <rule>               only report this rule (repeatable)
--ignore-identical <a,b>    values allowed to equal the source
--syntax <a,b>              override placeholder syntaxes
--limit <n>                 max findings printed (default: 40)
--json                      machine-readable output
```

Exit codes: `0` clean, `1` at least one error, `2` the tool itself failed.
Suitable for CI and pre-commit as-is.

## Not in v0

Translation memory and `stale` detection (source changed after translation),
PHP/`.po`/YAML formats, CLDR plural-category validation, glossary enforcement,
length overflow, and the MCP server wrapper. The core is a plain library so all
of those are additive.

## Development

```bash
npm install
npm run build
npm run demo
```

MIT.
