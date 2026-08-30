// Glossary behaviour that is easy to get wrong, each shown end to end.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { containsTerm, usesWordBoundaries } from '../dist/glossary.js';

console.log('=== term matching ===');
const cases = [
  ['Dodaj do koszyka', 'koszyk', 'prefix', 'inflected suffix'],
  ['Twój wózek jest pusty', 'koszyk', 'prefix', 'different word'],
  ['Добавить в корзину', 'корзин', 'prefix', 'Cyrillic stem'],
  ['Ваша корзина пуста', 'корзин', 'prefix', 'Cyrillic stem again'],
  ['カートは空です', 'カート', 'prefix', 'no word breaks'],
  ['買い物かごに追加', 'カート', 'prefix', 'no word breaks, absent'],
  ['Ajouter au panier', 'panier', 'exact', 'exact, whole word'],
  ['Ajouter aux paniers', 'panier', 'exact', 'exact rejects inflection'],
  ['Uncartlike wording', 'cart', 'prefix', 'must not match mid-word'],
  ['Paiement sécurisé', 'paiement', 'prefix', 'case-insensitive by default'],
];
for (const [text, term, mode, label] of cases) {
  const hit = containsTerm(text, term, mode);
  console.log(
    `${(hit ? 'match  ' : 'no     ')}${mode.padEnd(10)}${JSON.stringify(term).padEnd(12)} in ${JSON.stringify(text).padEnd(28)} ${label}`,
  );
}

console.log('\nusesWordBoundaries:');
for (const t of ['panier', 'корзин', 'カート', '购物车', 'ตะกร้า']) {
  console.log(`  ${t.padEnd(10)} -> ${usesWordBoundaries(t)}`);
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

run('inconsistent_translation is opt-in', [
  'check', 'fixtures/glossary', '--rule', 'inconsistent_translation',
]);

run('--no-glossary silences the term rules', [
  'check', 'fixtures/glossary', '--no-glossary',
]);

const WORK = 'fixtures/.glossary-errors';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/locales`, { recursive: true });
mkdirSync(`${WORK}/.i18n`, { recursive: true });
writeFileSync(`${WORK}/locales/en.json`, '{"a":"Your cart"}\n');
writeFileSync(`${WORK}/locales/fr.json`, '{"a":"Votre panier"}\n');

writeFileSync(
  `${WORK}/.i18n/glossary.json`,
  JSON.stringify({ version: 1, terms: [{ source: 'cart', targets: { fr: 'panier' } }] }, null, 2),
);
run('a malformed glossary names the offending entry', ['check', WORK]);

writeFileSync(`${WORK}/.i18n/glossary.json`, '{ "version": 2 }');
run('an unknown glossary version is refused', ['check', WORK]);

run('an explicitly named glossary must exist', ['check', WORK, '--glossary', 'nope.json']);

rmSync(WORK, { recursive: true, force: true });
