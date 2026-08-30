// gettext and YAML specifics, including the traps each format is known for.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parsePo, poKey } from '../dist/formats/po.js';
import { stripLocaleRoot } from '../dist/formats/yaml.js';
import { parse } from 'yaml';

console.log('=== .po parsing ===');
const po = `msgid ""
msgstr ""
"Plural-Forms: nplurals=3; plural=(n==1 ? 0 : 1);\\n"

#, fuzzy, c-format
msgid "Tab\\there"
msgstr "Onglet\\tici"

msgctxt "menu"
msgid "Open"
msgstr "Ouvrir"

msgid "Octal \\101 and hex \\x42"
msgstr "Octal A et hex B"

msgid ""
"split across "
"three "
"rows"
msgstr "réparti"

msgid "%d file"
msgid_plural "%d files"
msgstr[0] "%d fichier"
msgstr[1] "%d fichiers"

#~ msgid "gone"
#~ msgstr "parti"
`;

const parsed = parsePo(po, '<inline>');
console.log(`nplurals: ${parsed.nplurals}`);
for (const e of parsed.entries) {
  console.log(
    `  ${JSON.stringify(poKey(e)).padEnd(28)} fuzzy=${String(e.fuzzy).padEnd(5)} forms=${e.msgstr.length}  ${JSON.stringify(e.msgstr)}`,
  );
}

console.log('\n=== YAML: the Norway problem ===');
const doc = 'en:\n  languages:\n    en: English\n    no: Norwegian\n    yes: Affirmative\n';
const tree = parse(doc);
const inner = stripLocaleRoot(tree, 'en');
console.log('  parsed keys:', JSON.stringify(Object.keys(inner.languages)));
console.log('  values     :', JSON.stringify(inner.languages));
console.log('  (under YAML 1.1 "no" and "yes" would have become booleans)');

console.log('\n=== YAML: locale root stripping ===');
for (const [text, locale] of [
  ['en:\n  a: one\n', 'en'],
  ['pt-BR:\n  a: um\n', 'pt_BR'],
  ['a: one\nb: two\n', 'en'],
  ['de:\n  a: eins\n', 'en'],
]) {
  const out = stripLocaleRoot(parse(text), locale);
  console.log(`  ${JSON.stringify(text).padEnd(24)} as ${locale.padEnd(6)} -> ${JSON.stringify(out)}`);
}

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  try {
    process.stdout.write(
      execFileSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' }),
    );
  } catch (err) {
    process.stdout.write(err.stdout ?? '');
    process.stderr.write(err.stderr ?? '');
    console.log(`(exit ${err.status})`);
  }
}

const WORK = 'fixtures/.format-errors';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/locales`, { recursive: true });

writeFileSync(`${WORK}/locales/en.yml`, 'en:\n  a: &shared Reusable\n  b: *shared\n');
writeFileSync(`${WORK}/locales/de.yml`, 'de:\n  a: Wiederverwendbar\n  b: Wiederverwendbar\n');
run('YAML anchors and aliases resolve', ['check', WORK]);

writeFileSync(`${WORK}/locales/de.yml`, 'de:\n  a: [unclosed\n');
run('a broken YAML file names the file', ['check', WORK]);

rmSync(`${WORK}/locales/de.yml`, { force: true });
rmSync(`${WORK}/locales/en.yml`, { force: true });
writeFileSync(`${WORK}/locales/en.po`, 'msgid "Hi"\nmsgstr ""\n');
writeFileSync(`${WORK}/locales/fr.po`, 'msgid "Hi"\nmsgstr "Salut"\nthis is not po\n');
run('a broken .po file names the line', ['check', WORK]);

rmSync(WORK, { recursive: true, force: true });
