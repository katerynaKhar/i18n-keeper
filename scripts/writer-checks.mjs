// Writing back into PHP, YAML and gettext without losing what reading throws
// away. No network: proposals are constructed directly.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { applyProposals } from '../dist/apply.js';
import { detectProject, loadBundle } from '../dist/scan.js';

const WORK = 'fixtures/.writers';
rmSync(WORK, { recursive: true, force: true });

const proposal = (locale, key, value) => ({
  locale,
  key,
  kind: 'repair',
  source: 'not used by the writer',
  value,
  accepted: true,
  rejections: [],
  attempts: 1,
});

function apply(fixture, proposals) {
  const root = `${WORK}/${fixture}`;
  cpSync(`fixtures/${fixture}`, root, { recursive: true });
  const config = detectProject(root);
  const source = loadBundle(config, config.sourceLocale);
  return { root, result: applyProposals(config, source, proposals) };
}

const check = (label, condition) => console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`);

console.log('=== Laravel PHP ===');
{
  const { root, result } = apply('laravel', [
    proposal('fr', 'messages.cart.total', 'Total : :amount'),
    proposal('fr', 'messages.apostrophe', "C'est bon"),
    proposal('pl', 'validation.required', 'Pole :attribute jest wymagane.'),
  ]);
  console.log(`  written ${result.written}, skipped ${JSON.stringify(result.skipped)}`);

  const fr = readFileSync(`${root}/lang/fr/messages.php`, 'utf8');
  check('comment above the entry survived', fr.includes('Laravel renders :name'));
  check('escaped path untouched', fr.includes(String.raw`'path' => 'C:\\Users\\shared'`));
  check('unicode escape untouched', fr.includes(String.raw`"caf\u{e9}"`));
  check('double-quoted tab untouched', fr.includes(String.raw`"col1\tcol2"`));
  check('new key inserted and escaped', fr.includes(String.raw`'apostrophe' => 'C\'est bon',`));
  check(
    'php -l passes',
    execFileSync('php', ['-l', `${root}/lang/fr/messages.php`], { encoding: 'utf8' }).includes(
      'No syntax errors',
    ),
  );

  const dumped = JSON.parse(
    execFileSync('php', ['scripts/dump.php', `${root}/lang/fr/messages.php`], { encoding: 'utf8' }),
  );
  check('value reads back through PHP', dumped.cart.total === 'Total : :amount');
  check('inserted value reads back', dumped.apostrophe === "C'est bon");

  const created = JSON.parse(
    execFileSync('php', ['scripts/dump.php', `${root}/lang/pl/validation.php`], {
      encoding: 'utf8',
    }),
  );
  check('missing file created', created.required === 'Pole :attribute jest wymagane.');
}

console.log('\n=== Rails YAML ===');
{
  const { root, result } = apply('rails', [
    proposal('pl', 'cart.empty', 'Twój koszyk jest teraz pusty'),
    proposal('pl', 'items.few', '%{count} produkty'),
  ]);
  console.log(`  written ${result.written}, skipped ${JSON.stringify(result.skipped)}`);

  const pl = readFileSync(`${root}/config/locales/pl.yml`, 'utf8');
  check('locale root kept', pl.startsWith('pl:'));
  check('block scalar still a block scalar', pl.includes('greeting: |'));
  check('untouched keys unchanged', pl.includes('no: Norweski'));
  check('value replaced', pl.includes('empty: "Twój koszyk jest teraz pusty"'));
  check('plural form the source lacks was added', /^\s+few: /m.test(pl));
  check('no stray json file', !existsSync(`${root}/config/locales/pl.json`));
}

console.log('\n=== gettext ===');
{
  const { root, result } = apply('gettext', [
    proposal('pl', 'messages.Add to cart', 'Dodaj do koszyka'),
    proposal('pl', 'messages.adjective|Open', 'Otwarty'),
    proposal('uk', 'messages.Add to cart', 'Додати до кошика'),
  ]);
  console.log(`  written ${result.written}`);
  for (const skip of result.skipped) {
    console.log(`  skipped: ${skip.locale} ${skip.key} — ${skip.reason}`);
  }

  const pl = readFileSync(`${root}/locale/pl/LC_MESSAGES/messages.po`, 'utf8');
  check('header kept', pl.includes('Plural-Forms: nplurals=3'));
  check('obsolete block kept', pl.includes('#~ msgid "Removed long ago"'));
  check('multi-line msgid kept', pl.includes('"A long line split across "'));
  check('written entry marked fuzzy', pl.includes('#, fuzzy\nmsgid "Add to cart"'));
  check('context appended correctly', pl.includes('msgctxt "adjective"\nmsgid "Open"'));
  check('no catalogue invented for uk', !existsSync(`${root}/locale/uk`));
}

rmSync(WORK, { recursive: true, force: true });
