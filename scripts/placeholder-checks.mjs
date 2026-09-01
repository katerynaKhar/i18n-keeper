// Placeholder comparison against the substitution rules the frameworks actually
// use. Every case here came from running the linter on a real project and
// finding it wrong; the exit code is asserted rather than eyeballed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { diffPlaceholders, extractPlaceholders } from '../dist/placeholders.js';

const LARAVEL = ['mustache', 'ruby', 'icu_complex', 'icu', 'printf', 'tag', 'laravel'];

let failed = 0;

function compare(source, target, syntaxes = LARAVEL) {
  const from = extractPlaceholders(source, syntaxes);
  return diffPlaceholders(from, extractPlaceholders(target, syntaxes, from.keys()));
}

function expect(label, source, target, missing, extra) {
  const got = compare(source, target);
  const ok =
    got.missing.join(',') === missing.join(',') && got.extra.join(',') === extra.join(',');
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`       target   ${JSON.stringify(target)}`);
    console.log(`       expected missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
    console.log(`       got      missing ${JSON.stringify(got.missing)} extra ${JSON.stringify(got.extra)}`);
  }
}

console.log('=== Laravel substitutes with strtr(), which needs no word boundary ===');

// Somali glues the definite article straight onto the token; Laravel replaces
// the :attribute prefix and leaves the -ka. Read greedily, one correct string
// reported as both a lost :attribute and an invented :attributeka.
expect(
  'suffix glued on the right (Somali)',
  'The :attribute field must be accepted.',
  ':attributeka waa in la aqbalaa.',
  [],
  [],
);
expect(
  'suffix in another script (Amharic)',
  'The :attribute field must be accepted.',
  ':attributeቱ መቀበል አለባቸው.',
  [],
  [],
);
expect(
  'glued on the left (Shona)',
  'I agree to the :terms_of_service and :privacy_policy',
  'Ini ndinobvumirana ne:terms_of_service uye :privacy_policy',
  [],
  [],
);
expect(
  'Laravel also substitutes :Name and :NAME',
  'The :attribute field must be accepted.',
  ':Attribute inofanira kugamuchirwa.',
  [],
  [],
);

console.log('\n=== what must still be caught ===');

// The real defect in Laravel-Lang: :perPage was read as two words and the
// second half translated, so nothing substitutes and the count never appears.
expect(
  'a name the source does not offer is still extra',
  'Load :perPage More',
  'Загрузіць яшчэ :per старонкі',
  [':perpage'],
  [':per'],
);
expect(
  'a lost placeholder is still lost',
  'Edit :resource',
  'Субтитри:',
  [':resource'],
  [],
);
// Without the boundary check, every "Warning:Important" in prose would count.
expect(
  'prose is not a placeholder',
  'Warning',
  'Warning:Important',
  [],
  [],
);

console.log('\n=== the same string with the laravel syntax off ===');
{
  const got = compare('Load :perPage More', 'Загрузіць яшчэ :per старонкі', [
    'mustache',
    'ruby',
    'icu',
  ]);
  const ok = got.missing.length === 0 && got.extra.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} nothing is reported when :name is not a syntax in use`);
}

// ---------------------------------------------------------------------------

const ROOT = 'fixtures/.placeholders';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });

// English writes the `one` form without a count because English `one` means
// exactly 1. Gaelic `one` also covers 11 and keeps it; Afrikaans keeps it
// because "less than 1 minute" reads better. Both are rendered from the same
// arguments, so neither invented anything.
writeFileSync(
  `${ROOT}/locales/en.json`,
  JSON.stringify(
    {
      less_than_x_minutes: { one: 'less than a minute', other: 'less than %{count} minutes' },
      apples: { one: 'one apple', other: '%{count} apples' },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  `${ROOT}/locales/gd.json`,
  JSON.stringify(
    {
      less_than_x_minutes: {
        one: 'nas lugha na %{count} mhionaid',
        two: 'nas lugha na %{count} mhionaid',
        few: 'nas lugha na %{count} mionaidean',
        other: 'nas lugha na %{count} mionaid',
      },
      // A name the source uses nowhere in the group is still invented.
      apples: { one: 'ubhal %{colour}', other: '%{count} ubhal' },
    },
    null,
    2,
  ) + '\n',
);

function findings(args) {
  try {
    const out = execFileSync(process.execPath, ['dist/cli.js', 'check', ROOT, '--json', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out).findings;
  } catch (err) {
    return JSON.parse(err.stdout ?? '{"findings":[]}').findings;
  }
}

console.log('\n=== a plural form may need what its own source form does without ===');
{
  const extra = findings([]).filter((f) => f.rule === 'placeholder_extra');
  const keys = extra.map((f) => f.key).sort();
  const ok = keys.length === 1 && keys[0] === 'apples.one';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} only the name absent from the whole group is reported`);
  for (const f of extra) console.log(`       ${f.locale}  ${f.key}  ${f.detail}`);
}

// ---------------------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });

// Laravel's pipe segments are alternatives; exactly one is ever rendered.
writeFileSync(
  `${ROOT}/locales/en.json`,
  JSON.stringify({ errors: '(and :count more error)|(and :count more errors)' }, null, 2) + '\n',
);
writeFileSync(
  `${ROOT}/locales/ja.json`,
  JSON.stringify({ errors: '(その他、:countエラーあり)' }, null, 2) + '\n',
);
writeFileSync(
  `${ROOT}/locales/as.json`,
  JSON.stringify({ errors: '(আৰু আৰু ১০টা ভুল)' }, null, 2) + '\n',
);

console.log('\n=== pipe segments are alternatives, not a sentence ===');
{
  const lost = findings(['--syntax', LARAVEL.join(',')]).filter(
    (f) => f.rule === 'placeholder_missing',
  );
  const ja = lost.filter((f) => f.locale === 'ja');
  const as = lost.filter((f) => f.locale === 'as');
  const ok = ja.length === 0 && as.length === 1 && !/x\d/.test(as[0]?.detail ?? 'x2');
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} collapsing two segments into one loses nothing`);
  for (const f of lost) console.log(`       ${f.locale}  ${f.key}  ${f.detail}`);
}

// ---------------------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });

// The source form is complete for its own language and incomplete for others,
// so nothing is missing relative to it and no other rule looks here.
writeFileSync(
  `${ROOT}/locales/en.json`,
  JSON.stringify(
    { less_than_x_minutes: { one: 'less than a minute', other: 'less than %{count} minutes' } },
    null,
    2,
  ) + '\n',
);
const forms = {
  // one also covers 21, 31, 41 — "manje od minute" claims 21 minutes is under one
  bs: 'manje od minute',
  // one also covers 101
  sl: 'manj kot ena minuta',
  // one is exactly 1, so the phrase says everything there is to say
  de: 'weniger als eine Minute',
  // one also covers 0, which is a fact about agreement: zero minutes really is
  // less than a minute
  fr: "moins d'une minute",
  // one covers 1 and 11, and this one kept the count
  gd: 'nas lugha na %{count} mhionaid',
};
for (const [locale, one] of Object.entries(forms)) {
  writeFileSync(
    `${ROOT}/locales/${locale}.json`,
    JSON.stringify({ less_than_x_minutes: { one, other: 'x %{count} y' } }, null, 2) + '\n',
  );
}

console.log('\n=== a form whose category reaches further than the source can say ===');
{
  const hits = findings([]).filter((f) => f.rule === 'plural_needs_placeholder');
  const locales = hits.map((f) => f.locale).sort();
  const ok = locales.join(',') === 'bs,sl';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} only the categories that reach past one are reported`);
  if (!ok) console.log(`       got ${JSON.stringify(locales)}, expected ["bs","sl"]`);
  for (const f of hits) console.log(`       ${f.locale}  ${f.detail}`);
}

rmSync(ROOT, { recursive: true, force: true });

console.log(failed === 0 ? '\nall placeholder checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
