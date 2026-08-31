// save → apply, and every way a saved proposal can go stale before it lands.
// No network: the proposals file is written by hand, exactly as a hand-edited
// one would be.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = 'fixtures/.apply';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });
mkdirSync(`${ROOT}/.i18n`, { recursive: true });

const en = {
  cart: { empty: 'Your cart is empty', total: 'Total: {{amount}}' },
  gone: 'A string about to be deleted',
  moved: 'A string about to be reworded',
};
writeFileSync(`${ROOT}/locales/en.json`, JSON.stringify(en, null, 2) + '\n');
writeFileSync(`${ROOT}/locales/fr.json`, JSON.stringify({}, null, 2) + '\n');
writeFileSync(
  `${ROOT}/.i18n/glossary.json`,
  JSON.stringify(
    { version: 1, doNotTranslate: [], terms: [{ source: 'cart', targets: { fr: ['panier'] } }] },
    null,
    2,
  ) + '\n',
);

const proposal = (key, source, value, accepted = true) => ({
  locale: 'fr',
  key,
  kind: 'fill',
  source,
  value,
  accepted,
  rejections: accepted ? [] : ['made up an example rejection'],
  attempts: 1,
});

writeFileSync(
  `${ROOT}/proposals.json`,
  JSON.stringify(
    {
      version: 1,
      model: 'claude-opus-5',
      sourceLocale: 'en',
      createdAt: '2026-08-31T09:00:00.000Z',
      aborted: null,
      proposals: [
        proposal('cart.empty', en.cart.empty, 'Votre panier est vide'),
        // Hand-edited after saving: the placeholder is gone.
        proposal('cart.total', en.cart.total, 'Total :'),
        proposal('gone', en.gone, 'Une chaîne sur le point d’être supprimée'),
        proposal('moved', en.moved, 'Une chaîne sur le point d’être reformulée'),
        proposal('cart.empty', en.cart.empty, 'Votre chariot est vide', false),
      ],
    },
    null,
    2,
  ) + '\n',
);

// The project moves on after the proposals were saved.
delete en.gone;
en.moved = 'A string that has now been reworded';
writeFileSync(`${ROOT}/locales/en.json`, JSON.stringify(en, null, 2) + '\n');

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

run('apply --dry-run: the gate runs again', [
  'apply',
  `${ROOT}/proposals.json`,
  ROOT,
  '--dry-run',
]);

run('apply', ['apply', `${ROOT}/proposals.json`, ROOT]);

console.log('\nfr.json now:');
console.log(
  readFileSync(`${ROOT}/locales/fr.json`, 'utf8')
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')
    .trimEnd(),
);

const memory = JSON.parse(readFileSync(`${ROOT}/.i18n/memory.json`, 'utf8'));
console.log('memory:', JSON.stringify(memory.entries.fr));

run('a missing file', ['apply', `${ROOT}/nope.json`, ROOT]);

writeFileSync(`${ROOT}/bad.json`, JSON.stringify({ version: 99, proposals: [] }));
run('an unknown version', ['apply', `${ROOT}/bad.json`, ROOT]);

writeFileSync(`${ROOT}/bad.json`, '{ not json');
run('a malformed file', ['apply', `${ROOT}/bad.json`, ROOT]);

run('apply without a file', ['apply']);

rmSync(ROOT, { recursive: true, force: true });
