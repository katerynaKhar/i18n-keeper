# i18n-keeper

[![npm](https://img.shields.io/npm/v/@katerynakhar/i18n-keeper)](https://www.npmjs.com/package/@katerynakhar/i18n-keeper)
[![CI](https://github.com/katerynaKhar/i18n-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/katerynaKhar/i18n-keeper/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@katerynakhar/i18n-keeper)](https://nodejs.org)

Deterministic linter for JSON, Laravel PHP, gettext and YAML locale files, as a
CLI, an MCP server and an ESLint plugin. No LLM, no network, no API key — every
finding is mechanically verifiable, which is the point: you can trust the report
in languages you do not read.

```bash
npx @katerynakhar/i18n-keeper check
```

For the same checks inside ESLint, reported on the line the key is written on,
see [eslint-plugin-i18n-keeper](https://github.com/katerynaKhar/eslint-plugin-i18n-keeper).

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
| `missing_key` | error | Not translated: absent from a target, or present and empty |
| `structure_mismatch` | error | Value on one side, object on the other |
| `placeholder_missing` | error | `{{name}}`, `%s`, `<0>` dropped in translation |
| `placeholder_extra` | error | Placeholder that does not exist in the source |
| `orphan_key` | warning | Key in a target locale, gone from the source |
| `identical_to_source` | off | Probably untranslated — but usually a proper noun, so opt in |
| `stale` | warning | Source changed after the translation was recorded |
| `untracked` | off | Translated but absent from the memory |
| `icu_syntax_error` | error | Malformed ICU message — throws at format time |
| `plural_missing_category` | warning | Plural lacks a form the target language requires |
| `plural_extra_category` | warning | Plural branch the target language never selects |
| `plural_needs_placeholder` | warning | Source form names its quantity in words; the target's category covers more numbers than that |
| `plural_selector_lost` | warning | Laravel `a|b` selection flattened to one form |
| `dnt_violation` | warning | A do-not-translate token did not survive |
| `glossary_violation` | warning | A glossary term rendered with an unapproved word |
| `inconsistent_translation` | off | One source string translated two different ways |
| `length_over_max` | warning | Wider than the limit configured for that key |
| `length_overflow` | off | Grew more than translation expansion normally allows |

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

## String length

German runs about a third longer than English, so a button that fits in the
source overflows its container once translated — silently, because nothing
throws.

### Measured in display columns, not characters

```
"Subscribe"                .length   9   columns   9
"Newsletter abonnieren"    .length  21   columns  21
"ニュースレターを購読する"      .length  12   columns  24
"설정"                      .length   2   columns   4
```

That Japanese string is twelve characters and would pass a limit of sixteen.
It occupies twenty-four columns and does not fit. CJK and fullwidth characters
count as two, combining marks and variation selectors as zero.

Strings that are never displayed whole are not measured whole: an ICU plural
holds every branch at once but shows one, so it is skipped entirely, and
Laravel's `a|b` is measured at its widest segment.

### Explicit limits

`.i18n/limits.json`, checked against every locale including the source:

```json
{
  "version": 1,
  "keys": { "cta.subscribe": 16 },
  "patterns": [{ "match": "nav.*.button", "max": 12 }]
}
```

An exact key beats a pattern, the first matching pattern beats `default`, and
anything unmatched is not checked. `*` matches any run of characters.

```
de  cta.subscribe        length_over_max  21 columns, limit 16
de  nav.settings.button  length_over_max  13 columns, limit 12
ja  cta.subscribe        length_over_max  24 columns, limit 16
```

### Expansion without configuration

`length_overflow` needs no limits file: it compares each translation to its
source and complains when it grew more than translation normally does. A single
ratio would be useless — short strings expand far more in relative terms — so
the allowance shrinks as strings grow:

| Source width | Allowed |
|---|---|
| ≤ 10 columns | 300% |
| ≤ 20 | 200% |
| ≤ 30 | 180% |
| ≤ 50 | 160% |
| ≤ 70 | 140% |
| longer | 130% |

These are the conventional expansion rules of thumb, not a standard, and the
rule is approximate by nature — so it is off until asked for with `--rule
length_overflow`.

```
de  settings.delete  length_overflow  36 columns vs 14 in source — 257%, allowance 200%
de  body.welcome     length_overflow  130 columns vs 93 in source — 140%, allowance 130%
```

## Glossary and do-not-translate

Translating one string well is easy. Keeping one word rendered the same way
across three thousand keys, several translators and two years is the part that
drifts — and it is checkable without knowing the language.

`.i18n/glossary.json`, committed alongside the memory:

```json
{
  "version": 1,
  "doNotTranslate": ["Acme", "GitHub", "OAuth"],
  "terms": [
    {
      "source": "cart",
      "targets": {
        "fr": ["panier"],
        "pl": ["koszyk"],
        "ru": ["корзин"],
        "ja": ["カート"]
      }
    }
  ]
}
```

A term is only checked in strings whose **source** actually contains it, and
only for locales the entry lists. Anything you have not defined is not judged.

```
pl  cart.empty       glossary_violation  "cart" should be "koszyk"
pl  auth.signin      dnt_violation       GitHub must stay verbatim
ja  cart.add         glossary_violation  "cart" should be "カート"
```

### Matching is built for inflected languages

Demanding a literal substring would fire on every correctly translated Slavic
string, so matching is **prefix by default**: a term written `koszyk` accepts
`koszyka`, and `корзин` accepts `корзина`, `корзину` and `корзине`. Write the
stem, not the dictionary form. Per entry, `"match"` can be `"exact"` or
`"substring"` instead, and `"caseSensitive"` can be turned on.

A term still has to start a word, so `cart` does not match `Uncartlike`. That
check is skipped for scripts written without spaces — Japanese, Chinese, Thai,
Khmer, Lao, Burmese — where a term is normally surrounded by other letters and a
boundary test would never match at all.

Do-not-translate tokens are compared **case-sensitively**, because that is the
whole point of a brand name: `Github` is reported where `GitHub` was expected.

### Consistency without a glossary

`inconsistent_translation` needs no configuration: it reports one source string
that received two different translations within a locale. Reusing a wording is
often deliberate, so it is off until asked for with `--rule
inconsistent_translation`.

## Plural forms

English has two plural forms, Polish has four, Arabic has six, Japanese has one.
A translation copied from the English shape is therefore not merely stylistically
off — it renders the wrong grammar for whole ranges of numbers, silently.

Categories come from `Intl.PluralRules`, i.e. the ICU data already in the
runtime, rather than a table in this repository that would drift out of date.

```
pl  cart.removed  plural_missing_category  pl needs one/few/many/other, has one/other
ja  cart.removed  plural_extra_category    one is not a plural category in ja
ar  file_*        plural_missing_category  ar needs zero/one/two/few/many/other, has one/other
```

Three plural conventions are understood: ICU messages
(`{count, plural, one {# item} other {# items}}`), i18next suffix keys
(`item_one`, `item_few`), and Rails or Symfony nesting (`items.one`,
`items.few`). Findings name the group the way the project writes it —
`item_*` or `items.*`.

A single sibling is not treated as a plural group, so a key literally named
`numbers.one` is never asked to grow a `few` form.

Getting this right also **removes** findings that a locale-diffing tool would
otherwise invent:

- `item_few` exists in Polish and not in English. That is correct, not an orphan.
- `item_one` is absent from Japanese, which has no such form. That is correct,
  not a missing key — and it is left out of the coverage denominator, so a
  complete Japanese locale reads as 100%.

When a locale tag is not recognised, nothing is asserted. `Intl.PluralRules`
quietly falls back to the system locale for unknown tags — asking about `zz` on
a Russian machine reports four categories — so a resolved language subtag that
does not match the request is treated as unknown rather than as an answer.

Laravel's `a|b` and `{0} none|[1,*] many` selection is its own mechanism, not
CLDR, so it is not judged against CLDR categories. The one unambiguous failure —
a source that selects between forms translated as a single form — is reported as
`plural_selector_lost`.

### When the source itself is not enough

`one` does not mean one everywhere. English `one` is exactly 1, so English can
write

```yaml
less_than_x_minutes:
  one: less than a minute
  other: less than %{count} minutes
```

and be complete. Bosnian `one` also covers 21, 31 and 41; Slovenian `one` also
covers 101; Scottish Gaelic `one` also covers 11. A translation that copies the
English shape — *manje od minute*, *manj kot ena minuta* — then tells a Bosnian
reader that twenty-one minutes is less than one.

No comparison against the source can find this, because nothing is missing
relative to the source: the source form is correct for its own language and
insufficient for another. `plural_needs_placeholder` reports it, naming the
numbers that break:

```
bs  ….less_than_x_minutes.one  %{count} dropped, but one in bs also covers 21, 31, 41
```

Only quantities above one count. Several languages — French, Hindi, Persian —
put 0 in `one` as well, but that is a fact about agreement rather than about
quantity: zero minutes really is less than a minute. Requiring a count there
would report a dozen locales for nothing.

## Placeholder syntaxes

Detected by default: `{{name}}` (mustache/i18next), `{name}` and
`{count, plural, ...}` (ICU), `%{name}` (Ruby), `%s` / `%1$s` (printf),
`<0>…</0>` (react-i18next `<Trans>`).

Patterns are applied most-specific first and each match is masked out, so
`{{name}}` is never also counted as `{name}`.

Laravel's `:name` is off in a plain JSON project, where it false-positives on
prose like `Warning:Important`. It turns on for a PHP project — one with PHP
language files, a `composer.json`, or a `lang/` directory — because Laravel
keeps string-keyed translations in `lang/xx.json`, placeholders and all, so the
file extension alone would miss them. `--syntax` overrides the choice.

### Compared the way the framework substitutes

A placeholder is judged against how it will actually be replaced at runtime,
not against how it looks.

Laravel substitutes with `strtr()`, which needs no word boundary on either
side. Somali writes `:attributeka` and Shona writes `ne:terms_of_service`; both
render correctly, because `strtr` replaces the name it finds and leaves the rest
of the word alone. Read as plain tokens, each of those is reported twice — once
as a lost `:attribute` and once as an invented `:attributeka`. So when the names
the source offers are known, a match is cut back to the longest of them it
contains, exactly as `strtr` would. A name the source never offers still has to
stand on its own, or it is prose rather than a placeholder.

Laravel's pipe segments are alternatives: one of them is rendered, never all
three. A locale that collapses `one|few|other` into a single form has not lost
two copies of `:count`, so for those strings the names are compared without
their multiplicity.

Every form of one plural message is rendered from the same arguments, so a
placeholder used anywhere in the group can be used in any form of it. English
writes `less_than_x_minutes.one` as "less than a minute" — English `one` means
exactly 1 — while Scottish Gaelic `one` also covers 11 and has to keep the
count. That is a requirement of the language, not an invention.

Each of these was found by running the linter over a real project and reading
what it said, which is the only way any of them could have been found.

## Formats and layouts

JSON, Laravel PHP, gettext and YAML, in either layout, auto-detected:

```
locales/en.json              locales/en/common.json        -> common.cart.total
lang/en.php                  lang/en/validation.php        -> validation.max.string
config/locales/en.yml        locale/en/LC_MESSAGES/app.po  -> app.<msgid>
```

Formats can coexist: a locale directory holding `messages.php` next to a
`lang/en.json` is read as one keyspace. When PHP files are present, Laravel's
`:name` interpolation is enabled automatically, and `:name`, `:Name` and
`:NAME` are treated as one placeholder because Laravel renders them from the
same replacement.

### gettext

The msgid *is* the source text, so a `.pot` — or any catalogue with empty
`msgstr` — works as the source locale without a parallel English file.

The format also already tracks what the translation memory was built for: an
entry flagged `#, fuzzy` is reported as `stale` with no memory involved.

```
fr  messages.Add to cart     stale                    marked fuzzy in the catalogue
fr  messages.Welcome, %s!    placeholder_missing      %s lost
pl  messages.adjective|Open  missing_key              not translated
pl  messages.%d file         plural_missing_category  header declares nplurals=3, entry has 2
```

`msgctxt` disambiguates, and shows in keys as `context|msgid`. Entries
commented out with `#~` are already removed from the catalogue and are not
reported as orphans. `LC_MESSAGES` is dropped from key paths, since it is
directory layout rather than namespace. The last check above needs no CLDR at
all: the catalogue header states its own form count.

### YAML

Rails nests a whole file under its locale code, which is stripped — otherwise
every key in `en.yml` would differ from every key in `fr.yml`. Rails also
writes plurals as nested `one:` / `other:` keys, which are recognised
alongside i18next's `item_one` suffixes.

This is the one format with a dependency (`yaml`). The PHP parser is hand
written because the alternative there was executing untrusted code; YAML poses
no such hazard, and its spec is deep enough — anchors, block scalars, implicit
typing — that a hand-rolled subset would quietly misread real files. Notably,
under YAML 1.1 a `no:` key becomes `false`, which would silently corrupt a
Norwegian entry; the library's 1.2 default keeps it a string.

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
i18n-keeper translate [path]  fill the missing and stale set with Claude
i18n-keeper apply <file> [path]  write proposals saved by translate
i18n-keeper review [path]   sign off on machine translations

--locales <dir>             locales directory (default: auto-detect)
--source <locale>           source locale (default: en, else the first found)
--locale <locale>           limit to this locale (repeatable)
--memory <file>             translation memory (default: .i18n/memory.json)
--no-memory                 ignore the memory; disables stale detection
--glossary <file>           glossary (default: .i18n/glossary.json)
--no-glossary               ignore the glossary
--limits <file>             width limits (default: .i18n/limits.json)
--no-limits                 ignore the width limits

check
--rule <rule>               only report this rule, enabling it if off (repeatable)
--ignore-identical <a,b>    values allowed to equal the source
--syntax <a,b>              override placeholder syntaxes
--limit <n>                 max findings printed (default: 40)
--json                      machine-readable output

sync
--origin <human|machine>    who produced these translations (default: human)
--force                     re-record unchanged translations, clearing stale

translate
--write                     apply accepted translations (default: write nothing)
--cap <n>                   most strings per run (default: 50)
--batch <n>                 strings per request (default: 20)
--model <id>                default: claude-opus-5
--effort <level>            low|medium|high|xhigh|max (default: medium)
--only <kind>               fill | repair | refresh (repeatable; default: all)
--save <file>               keep the proposals for a later apply

apply
--dry-run                   re-check the saved proposals and report, writing nothing

review
--key <k>                   only this key (repeatable)
--all                       every unreviewed translation
--dry-run                   list what would be signed off, changing nothing
```

Exit codes: `0` clean, `1` at least one error, `2` the tool itself failed.
Suitable for CI and pre-commit as-is.

## MCP server

The same core is exposed over MCP, so an agent can audit locales itself.

```bash
claude mcp add i18n-keeper -- node /path/to/i18n-keeper/dist/mcp.js
```

Or per project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "i18n-keeper": {
      "command": "node",
      "args": ["/path/to/i18n-keeper/dist/mcp.js"]
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

## Machine translation

Everything above is deterministic and offline. This one command is neither: it
calls Claude, and its output cannot be verified by reading it in a language you
do not speak.

So it is not trusted. **Every proposal goes back through the same checks the
linter applies, and anything that fails is rejected rather than written.**

```bash
i18n-keeper translate                     # propose, validate, print — writes nothing
i18n-keeper translate --write             # also apply the accepted ones
i18n-keeper translate --save review.json  # keep the proposals for later
i18n-keeper apply review.json             # write them, without translating again
```

The work list comes from the report, so the linter decides what needs doing —
in three kinds:

| Kind | From | Meaning |
|---|---|---|
| `fill` | `missing_key` | No usable translation exists — absent, or present and empty |
| `repair` | see below | One exists and the linter proved it wrong |
| `refresh` | `stale` | One exists and its source has moved |

Narrow it with `--only fill`, `--only repair`, `--only refresh` (repeatable).

### What counts as repairable

A defect is only handed back to the model if the local check can **confirm the
repair afterwards**. A fix nobody can verify is a fix nobody should trust, so
those findings are left for a human. That single rule picks the set:

`placeholder_missing`, `placeholder_extra`, `icu_syntax_error`,
`plural_missing_category`, `glossary_violation`, `dnt_violation`,
`length_over_max`.

It leaves out `identical_to_source` — often correct, since "Email" really is
"Email" in French, and forcing a change would make it worse — along with
`plural_extra_category` and `plural_selector_lost`, which the single-string
validator does not check and therefore could not confirm. It also leaves out
`plural_needs_placeholder` for the same reason turned inside out: the validator
compares a proposal against the source, and there the source is the thing that
falls short.

A repair is sent with the wording someone already chose and the exact findings
against it, and asked to change only what those require:

```json
{
  "key": "order.thanks",
  "source": "Thanks, {{name}}!",
  "placeholders_that_must_survive": ["{{name}}"],
  "current_translation": "Dziękujemy, {{imie}}!",
  "problems_to_fix": [
    "placeholder_extra: {{imie}} not in source",
    "placeholder_missing: {{name}} lost"
  ]
}
```

One key broken several ways carries every reason at once, and a repair that does
not actually repair is rejected like any other proposal.

### The constraints go in, not just on afterwards

Each string is sent with everything the checks will later demand of it: the
placeholders that must survive, the plural categories the target language
requires, the glossary forms and do-not-translate tokens that apply to *that*
string, and the width limit for that key.

Then the result is checked anyway. When a proposal fails, it goes back once with
the specific rule it broke:

```
  request: fr, 4 strings
  request: fr, 3 strings (retry)

  accept  cart.empty       Votre panier est vide
  accept  cart.total       Total : {{amount}}
  REJECT  nav.subscribe    S'abonner à la lettre d'information
          ! 35 columns, limit 12
```

The first attempt had dropped `{{amount}}` and translated *cart* as *chariot*
against the glossary; the retry fixed both. The third string was too wide twice
and was never written.

### Look first, apply later, pay once

`--save` keeps the proposals in a file that `apply` can write afterwards, so
reviewing before applying does not mean paying for the translation twice. The
file is written even when a run stops early, so partial work survives.

**`apply` puts every proposal through the checks again.** A saved file can be
days old and is editable by hand, so nothing is written on the strength of a
check made earlier against files that may since have moved:

```
dropped
  fr  cart.total   ! placeholders lost: {{amount}}
  fr  gone         ! the key is no longer in the source locale
  fr  moved        ! the source string changed after the proposal was made
  fr  cart.empty   ! was rejected when proposed
```

The first of those is a translation someone edited inside the saved file after
it had passed. It does not get written.

`apply --dry-run` reports without writing.

### Nothing is written by accident

Without `--write` the command only prints. With it, accepted translations are
applied and recorded in the memory as `origin: "machine"`, `reviewed: false` —
so a human can find every unreviewed machine string later, and `stale` keeps
working from there.

### Writing back without losing the file

Reading discards everything that is not a key or a value: comments, quote
styles, blank lines, anchors, translator notes. Writing must not. So no writer
re-serialises a parsed tree — each edits the text in place and leaves every byte
it had no reason to touch.

- **JSON** is the exception, and the easy one: no comments, no styles, nothing
  to lose, so it is re-serialised.
- **PHP** replaces the exact span of one value. A comment above the entry, a
  `'C:\\Users\\shared'` escape, a `"caf\u{e9}"` written with a unicode escape —
  all come out byte for byte as they went in. New keys are inserted into their
  array with the indentation the neighbours use, and missing levels are created.
- **YAML** goes through the document model, which keeps comments and anchors
  across a round trip. An existing scalar is mutated rather than replaced, so a
  block scalar stays a block scalar. **An alias is refused**: writing through
  `*shared` would silently change every key that shares the anchor.
- **gettext** is edited by line, leaving the header, obsolete `#~` entries and
  multi-line msgids alone. A new entry is appended with its `msgctxt`.

A gettext entry written this way is marked `#, fuzzy`. That flag is gettext's
own word for "no person has reviewed this", which is exactly what the memory
records as `reviewed: false`; leaving it off would claim an approval nobody
gave. `check` then reports those entries as stale, which is correct.

A locale file that does not exist yet is created for JSON and PHP, whose empty
form is unambiguous. It is not invented for YAML, whose shape depends on whether
the project nests under a locale root, nor for gettext, whose header declares
the language's own plural rules. Those are reported as not written.

Exit code is 1 whenever anything was rejected, so a pipeline notices.

A refusal applies to one batch and the run carries on. Anything else — no
credentials, a rate limit, a dropped connection — will hit every remaining
batch identically, so the run stops and says how many strings were never
attempted. Those are not reported as rejections: the checks never saw them.

### Signing off

Recording machine output as unreviewed is only useful if there is a way out of
that state, and nothing else in the tool provides one — not `sync`, not
`--force`. Only a person can say a translation is good:

```bash
i18n-keeper review                          # what is waiting, changing nothing
i18n-keeper review --locale pl              # sign off on one language
i18n-keeper review --key cart.empty         # or one string
i18n-keeper review --all                    # everything outstanding
```

With no selection it lists the queue with the source beside each translation,
so the review can happen in the terminal rather than by hunting through files:

```
  pl  cart.empty  (machine)
    en  Your cart is empty
    pl  Twój koszyk jest pusty

3 waiting. Sign off with --all, or narrow with --locale / --key.
```

A sign-off records `reviewedAt` and survives later edits to the *source*; only
rewriting the translation itself clears it. `--dry-run` shows what would be
marked without touching the file.

### Cost and credentials

Needs `ANTHROPIC_API_KEY`, or a profile from `ant auth login`. Defaults to
`claude-opus-5` at `--effort medium`, batches of 20 strings, and at most 50
strings per run — raise with `--cap`. The source strings, their keys and their
constraints are what gets sent.

## Known limits

- A gettext key joins `msgctxt` and `msgid` with `|`. A contextless msgid that
  contains a pipe is indistinguishable from a contextual one, which only matters
  when appending an entry the catalogue has never carried.
- New locale files are created for JSON and PHP only; see above.

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
npm run test:plurals   # ICU scanner and CLDR category resolution
npm run test:glossary  # term matching across scripts, and glossary errors
npm run test:lengths   # display width, limit resolution, limits-file errors
npm run test:formats   # gettext parsing, YAML typing traps, parse errors
npm run test:translate # the translation gate and repairs, against a stub client
npm run test:apply     # save/apply, and every way a saved proposal goes stale
npm run test:writers   # writing into PHP, YAML and gettext without losing anything
npm run test:review    # the review queue and its only exit
npm run test:detection # what a real third-party project taught the scanner
npm run demo:plurals   # five locales with one, two, four and six plural forms
npm run demo:glossary  # inflection, Cyrillic stems, CJK and brand names
npm run demo:lengths   # German expansion and double-width Japanese
npm run demo:gettext   # fuzzy entries, msgctxt, nplurals
npm run demo:rails     # locale roots and nested plural keys
```

MIT.
