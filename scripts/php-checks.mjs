// Targeted checks for the PHP/Laravel specifics that are easy to get wrong.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractPlaceholders } from '../dist/placeholders.js';

const withLaravel = ['mustache', 'ruby', 'icu_complex', 'icu', 'printf', 'tag', 'laravel'];
const show = (s) =>
  JSON.stringify(Object.fromEntries(extractPlaceholders(s, withLaravel)));

console.log('=== Laravel placeholder casing and false positives ===');
for (const s of [
  'Welcome back, :Name',
  'Welcome back, :name',
  'Welcome back, :NAME',
  'C:\\Users\\shared',
  'Note: this is prose',
  'Meeting at 12:30',
  'See https://example.com/x',
  'The :attribute may not exceed :max characters.',
]) {
  console.log(`${JSON.stringify(s).padEnd(50)} -> ${show(s)}`);
}

console.log('\n=== flat PHP layout (lang/en.php) ===');
const WORK = 'fixtures/.php-flat';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/lang`, { recursive: true });
writeFileSync(
  `${WORK}/lang/en.php`,
  "<?php\n\nreturn [\n    'greeting' => 'Hello :name',\n    'bye' => 'Goodbye',\n];\n",
);
writeFileSync(
  `${WORK}/lang/de.php`,
  "<?php\n\nreturn [\n    'greeting' => 'Hallo',\n];\n",
);

function run(args) {
  console.log(`\n$ i18n-keeper ${args.join(' ')}`);
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

run(['scan', WORK]);
run(['check', WORK]);

console.log('\n=== a broken PHP file reports the line, not a stack trace ===');
writeFileSync(`${WORK}/lang/fr.php`, "<?php\n\nreturn [\n    'greeting' => strtoupper('x'),\n];\n");
run(['check', WORK]);

rmSync(WORK, { recursive: true, force: true });
