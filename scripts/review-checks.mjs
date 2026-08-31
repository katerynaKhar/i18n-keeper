// The review queue: the only way a translation stops being unreviewed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = 'fixtures/.review';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });
mkdirSync(`${ROOT}/.i18n`, { recursive: true });

writeFileSync(
  `${ROOT}/locales/en.json`,
  JSON.stringify({ cart: { empty: 'Your cart is empty', add: 'Add to cart' } }, null, 2) + '\n',
);
writeFileSync(
  `${ROOT}/locales/fr.json`,
  JSON.stringify({ cart: { empty: 'Votre panier est vide', add: 'Ajouter au panier' } }, null, 2) +
    '\n',
);
writeFileSync(
  `${ROOT}/locales/pl.json`,
  JSON.stringify({ cart: { empty: 'Twój koszyk jest pusty', add: 'Dodaj do koszyka' } }, null, 2) +
    '\n',
);

const entry = (value, origin, reviewed) => ({
  sourceHash: 'ignored-here',
  value,
  origin,
  reviewed,
  updatedAt: '2026-08-31T09:00:00.000Z',
});

writeFileSync(
  `${ROOT}/.i18n/memory.json`,
  JSON.stringify(
    {
      version: 1,
      sourceLocale: 'en',
      entries: {
        fr: {
          'cart.empty': entry('Votre panier est vide', 'machine', false),
          'cart.add': entry('Ajouter au panier', 'human', true),
        },
        pl: {
          'cart.empty': entry('Twój koszyk jest pusty', 'machine', false),
          'cart.add': entry('Dodaj do koszyka', 'machine', false),
        },
      },
    },
    null,
    2,
  ) + '\n',
);

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

const state = () => {
  const m = JSON.parse(readFileSync(`${ROOT}/.i18n/memory.json`, 'utf8'));
  const rows = [];
  for (const [locale, keys] of Object.entries(m.entries)) {
    for (const [key, e] of Object.entries(keys)) {
      rows.push(`${locale} ${key} reviewed=${e.reviewed}${e.reviewedAt ? ' (signed off)' : ''}`);
    }
  }
  return rows;
};

run('no selection: lists the queue, changes nothing', ['review', ROOT]);
console.log('  state:', state().join(' | '));

run('--dry-run with a narrowed selection', ['review', ROOT, '--locale', 'pl', '--dry-run']);
console.log('  state:', state().join(' | '));

run('sign off on one key', ['review', ROOT, '--locale', 'pl', '--key', 'cart.add']);
console.log('  state:', state().join(' | '));

run('sign off on everything left', ['review', ROOT, '--all']);
console.log('  state:', state().join(' | '));

run('nothing left to review', ['review', ROOT]);

rmSync(`${ROOT}/.i18n/memory.json`, { force: true });
run('no memory at all', ['review', ROOT]);

rmSync(ROOT, { recursive: true, force: true });
