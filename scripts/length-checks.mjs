// Width measurement and limit resolution, plus the failure paths.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  allowanceFor,
  displayWidth,
  limitFor,
  measurable,
  renderedWidth,
} from '../dist/lengths.js';

console.log('=== .length lies, display columns do not ===');
for (const s of [
  'Subscribe',
  'Newsletter abonnieren',
  'ニュースレターを購読する',
  '설정',
  'café',
  '👍 done',
]) {
  console.log(
    `${JSON.stringify(s).padEnd(30)} .length ${String(s.length).padStart(3)}   columns ${String(displayWidth(s)).padStart(3)}`,
  );
}

console.log('\n=== what is measurable ===');
for (const s of [
  '{count, plural, one {# item} other {# items}}',
  'Hello {{name}}',
  'apple|apples',
]) {
  console.log(
    `${JSON.stringify(s).padEnd(48)} measurable ${measurable(s)}  laravel-width ${renderedWidth(s, true)}`,
  );
}

console.log('\n=== allowance shrinks as strings grow ===');
for (const n of [4, 10, 20, 30, 50, 70, 120]) {
  console.log(`  source ${String(n).padStart(3)} columns -> up to ${allowanceFor(n) * 100}%`);
}

console.log('\n=== limit resolution: exact beats pattern beats default ===');
const limits = {
  version: 1,
  default: 100,
  keys: { 'nav.home.button': 8 },
  patterns: [
    { match: 'nav.*.button', max: 12 },
    { match: '*.cta', max: 20 },
  ],
};
for (const key of ['nav.home.button', 'nav.cart.button', 'promo.cta', 'body.welcome']) {
  console.log(`  ${key.padEnd(20)} -> ${limitFor(limits, key)}`);
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

run('--no-limits silences the width rules', ['check', 'fixtures/lengths', '--no-limits']);

const WORK = 'fixtures/.length-errors';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/locales`, { recursive: true });
mkdirSync(`${WORK}/.i18n`, { recursive: true });
writeFileSync(`${WORK}/locales/en.json`, '{"a":"Hi"}\n');
writeFileSync(`${WORK}/locales/de.json`, '{"a":"Guten Tag miteinander"}\n');

writeFileSync(`${WORK}/.i18n/limits.json`, JSON.stringify({ version: 1, keys: { a: 0 } }));
run('a non-positive limit is refused', ['check', WORK]);

writeFileSync(
  `${WORK}/.i18n/limits.json`,
  JSON.stringify({ version: 1, patterns: [{ match: '*.x' }] }),
);
run('a pattern without a max is refused', ['check', WORK]);

run('an explicitly named limits file must exist', ['check', WORK, '--limits', 'nope.json']);

rmSync(WORK, { recursive: true, force: true });
