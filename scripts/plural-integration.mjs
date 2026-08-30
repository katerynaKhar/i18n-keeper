// Edge cases for the CLDR layer, each on a throwaway project.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = 'fixtures/.plural-cases';

function project(name, locales) {
  const dir = `${ROOT}/${name}/locales`;
  mkdirSync(dir, { recursive: true });
  for (const [locale, data] of Object.entries(locales)) {
    writeFileSync(`${dir}/${locale}.json`, `${JSON.stringify(data, null, 2)}\n`);
  }
  return `${ROOT}/${name}`;
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
  }
}

rmSync(ROOT, { recursive: true, force: true });

// 1. Broken ICU in the source is broken for everyone, not just one locale.
run('broken source ICU is attributed to the source locale', [
  'check',
  project('broken-source', {
    en: { n: '{count, plural, one {# thing} other {# things}' },
    de: { n: '{count, plural, one {# Ding} other {# Dinge}}' },
  }),
  '--rule', 'icu_syntax_error',
]);

// 2. An unrecognised locale must not inherit the machine's plural rules.
run('unknown locale: no plural claims at all', [
  'check',
  project('unknown-locale', {
    en: { items: '{count, plural, one {# item} other {# items}}', file_one: 'a', file_other: 'b' },
    zz: { items: '{count, plural, other {#}}', file_other: 'b' },
  }),
]);

// 3. A plain i18next project has no ICU anywhere; it must stay silent.
run('i18next {{...}} project produces no ICU findings', [
  'check',
  project('i18next-only', {
    en: { hello: 'Hi {{name}}', count: 'You have {{count}} items', esc: 'Braces {like} this' },
    de: { hello: 'Hallo {{name}}', count: 'Du hast {{count}} Artikel', esc: 'Klammern {like} so' },
  }),
]);

// 4. Turkish needs one/other like English: a correct file must be clean.
run('a fully correct pair reports nothing', [
  'check',
  project('clean', {
    en: { items: '{count, plural, one {# item} other {# items}}', file_one: 'a', file_other: 'b' },
    tr: { items: '{count, plural, one {# öğe} other {# öğe}}', file_one: 'c', file_other: 'd' },
  }),
]);

rmSync(ROOT, { recursive: true, force: true });
