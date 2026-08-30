# i18n-keeper

Deterministic linter for JSON and Laravel PHP locale files, as a CLI and an MCP
server. No LLM, no network, no API key — every finding is mechanically
verifiable, which is the point: you can trust the report in languages you do not
read.

```bash
npx i18n-keeper check
```

```
i18n check · source: en · 16 keys · locales

locale  coverage  missing  orphan  stale  errors  warnings
de         93.8%        0       0      2       1         2
es        100.0%        0       1      2       0         5
fr         93.8%        1       0      2       2         3
pl         68.8%        4       0      1       8         2

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
| `stale` | warning | Source changed after the translation was recorded |
| `untracked` | off | Translated but absent from the memory |

Errors break at runtime. Warnings only look bad — an outdated translation still
renders, so `stale` is a warning even though it is the most interesting rule
here. Naming a rule with `--rule` also enables it, so `--rule untracked` works
without extra configuration.

## Translation memory

Everything above compares locales against each other, which any script can do.
The memory is what makes the difference: it remembers **which source string a
translation was made from**, so a later edit to the source surfaces every
translation that silently went out of date.

```bash
i18n-keeper sync      # record what is already translated
# ... someone edits an English string ...
i18n-keeper check     # every locale still holding the old translation is stale
```

The memory lives at `.i18n/memory.json`, sorted for readable diffs, and is meant
to be committed — it turns translation state into something reviewable in git.

```json
{
  "version": 1,
  "sourceLocale": "en",
  "entries": {
    "fr": {
      "cart.checkout": {
        "sourceHash": "9d0277a31e87",
        "value": "Passer à la caisse",
        "origin": "human",
        "reviewed": true,
        "updatedAt": "2026-08-30T15:03:09.972Z"
      }
    }
  }
}
```

Two safeguards matter more than they look:

**`sync` never silently clears a stale flag.** An entry whose translation is
unchanged keeps its old source hash, because nothing about the translation was
actually redone. Only `sync --force` accepts the current state wholesale, and
the command says how many entries it deliberately left stale.

**A hand-edited translation is not called stale.** If the target no longer
matches what the memory recorded, someone already touched it and we cannot claim
it is outdated — so the rule stays quiet rather than guessing.

## Placeholder syntaxes

Detected by default: `{{name}}` (mustache/i18next), `{name}` and
`{count, plural, ...}` (ICU), `%{name}` (Ruby), `%s` / `%1$s` (printf),
`<0>…</0>` (react-i18next `<Trans>`).

Patterns are applied most-specific first and each match is masked out, so
`{{name}}` is never also counted as `{name}`.

Laravel's `:name` is off by default in JSON projects, where it false-positives
on prose like `Warning:Important`; it turns on automatically when the project
has PHP language files, and `--syntax` overrides the choice either way.

## Formats and layouts

JSON and Laravel-style PHP language files, in either layout, auto-detected:

```
locales/en.json              locales/en/common.json
locales/fr.json              locales/en/shop/pricing.json  -> shop.pricing.price

lang/en.php                  lang/en/messages.php          -> messages.cart.total
lang/fr.php                  lang/en/validation.php        -> validation.max.string
```

Both can coexist: a locale directory holding `messages.php` next to a
`lang/en.json` is read as one keyspace. When PHP files are present, Laravel's
`:name` interpolation is enabled automatically, and `:name`, `:Name` and
`:NAME` are treated as one placeholder because Laravel renders them from the
same replacement.

### PHP files are parsed, never executed

Locale files come from the repository being linted. Running them would mean
executing untrusted code, and would force PHP onto every machine and CI runner
using the linter. So `i18n-keeper` ships its own parser for the
`<?php return [...];` subset — literal arrays, both quote styles with full
escape handling, `array()`, integer and string keys, and all three comment
styles.

Anything outside that subset — variables, interpolation, concatenation,
function calls, heredocs, statements after the return — is a clear error naming
the line, not a silent guess:

```
Cannot parse lang/fr.php
  Constants and function calls are not supported (line 4)
```

The parser is verified differentially against PHP itself: `npm run test:php`
reads every fixture with the real interpreter and compares the two results
structurally. PHP is a development dependency for that test only.

## Usage

```
i18n-keeper check [path]    lint locale files
i18n-keeper scan  [path]    show what would be checked
i18n-keeper sync  [path]    record current translations in the memory

--locales <dir>             locales directory (default: auto-detect)
--source <locale>           source locale (default: en, else the first found)
--locale <locale>           limit to this locale (repeatable)
--memory <file>             translation memory (default: .i18n/memory.json)
--no-memory                 ignore the memory; disables stale detection

check
--rule <rule>               only report this rule, enabling it if off (repeatable)
--ignore-identical <a,b>    values allowed to equal the source
--syntax <a,b>              override placeholder syntaxes
--limit <n>                 max findings printed (default: 40)
--json                      machine-readable output

sync
--origin <human|machine>    who produced these translations (default: human)
--force                     re-record unchanged translations, clearing stale
```

Exit codes: `0` clean, `1` at least one error, `2` the tool itself failed.
Suitable for CI and pre-commit as-is.

## MCP server

The same core is exposed over MCP, so an agent can audit locales itself.

```bash
claude mcp add i18n-keeper -- node C:/Users/glize/work/i18n-keeper/dist/mcp.js
```

Or per project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "i18n-keeper": {
      "command": "node",
      "args": ["C:/Users/glize/work/i18n-keeper/dist/mcp.js"]
    }
  }
}
```

| Tool | Returns |
|---|---|
| `i18n_scan` | Locale directory, layout, locales and whether a memory exists |
| `i18n_status` | Per-locale coverage and counts, no individual findings |
| `i18n_check` | Findings, filterable by `locale` / `rule` / `severity`, paged via `offset` |
| `i18n_sync` | Records translations in the memory — the only tool that writes |

Findings are paged (25 per call by default) because tool output costs the agent
context; `i18n_status` exists so an agent can get the shape of the problem for a
few dozen tokens before asking for detail. `i18n_status`, `i18n_check` and
`i18n_sync` also return `structuredContent`, so the numbers can be consumed
without parsing the table.

## Not yet

Machine translation of the stale/missing set, `.po` and YAML formats, CLDR
plural-category validation, glossary and do-not-translate enforcement, and
length-overflow checks. The core is a plain library, so all of those are
additive.

## Development

```bash
npm install
npm run build
npm run demo           # CLI against the JSON demo fixture
npm run demo:laravel   # CLI against the Laravel fixture
npm run walkthrough    # the whole memory/stale lifecycle, step by step
npm run smoke          # drives the MCP server as a real client would
npm run test:php       # our PHP parser vs the real interpreter (needs php)
npm run test:laravel   # placeholder casing, flat PHP layout, parse errors
```

MIT.
