// End-to-end walkthrough of the memory/stale lifecycle on a scratch copy.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const WORK = 'fixtures/.walkthrough';
rmSync(WORK, { recursive: true, force: true });
cpSync('fixtures/demo', WORK, { recursive: true });

function run(args) {
  console.log(`\n$ i18n-keeper ${args.join(' ')}`);
  try {
    const out = execFileSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (err) {
    process.stdout.write(err.stdout ?? '');
    process.stderr.write(err.stderr ?? '');
    console.log(`(exit ${err.status})`);
  }
}

function editLocale(locale, mutate) {
  const file = `${WORK}/locales/${locale}.json`;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mutate(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

console.log('=== 1. first adoption: record what is already translated ===');
run(['sync', WORK]);

console.log('\n=== memory.json (excerpt) ===');
const mem = JSON.parse(readFileSync(`${WORK}/.i18n/memory.json`, 'utf8'));
console.log(JSON.stringify({ version: mem.version, sourceLocale: mem.sourceLocale }, null, 2));
console.log('fr.cart.checkout ->', JSON.stringify(mem.entries.fr['cart.checkout'], null, 2));
console.log('locales tracked:', Object.keys(mem.entries).join(', '));
console.log('fr entries:', Object.keys(mem.entries.fr).length);

console.log('\n=== 2. clean run: memory present, nothing stale ===');
run(['check', WORK, '--rule', 'stale']);

console.log('\n=== 3. the source copy changes ===');
editLocale('en', (d) => {
  d.cart.checkout = 'Go to checkout';
  d.nav.account = 'Your account';
});
run(['check', WORK, '--rule', 'stale']);

console.log('\n=== 4. a translator updates fr only ===');
editLocale('fr', (d) => {
  d.cart.checkout = 'Aller au paiement';
});
run(['check', WORK, '--rule', 'stale', '--locale', 'fr']);

console.log('\n=== 5. sync records the redone translation, keeps the rest stale ===');
run(['sync', WORK]);
run(['check', WORK, '--rule', 'stale']);

console.log('\n=== 6. --force accepts everything as current ===');
run(['sync', WORK, '--force']);
run(['check', WORK, '--rule', 'stale']);

console.log('\n=== 7. untracked is off by default, opt in explicitly ===');
editLocale('en', (d) => {
  d.nav.help = 'Help';
});
editLocale('de', (d) => {
  d.nav.help = 'Hilfe';
});
run(['check', WORK, '--rule', 'untracked', '--locale', 'de']);

rmSync(WORK, { recursive: true, force: true });
