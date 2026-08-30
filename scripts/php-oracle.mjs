// Differential test: our TypeScript parser vs PHP itself.
//
// The linter must never execute locale files, so it ships its own parser. To
// prove that parser right, every fixture is also read by the real interpreter
// and the two results are compared structurally.
//
// Requires php on PATH. Development-only; not needed to run i18n-keeper.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePhp } from '../dist/formats/php.js';

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.php')) acc.push(full.split('\\').join('/'));
  }
  return acc;
}

function phpVersion() {
  try {
    return execFileSync('php', ['-v'], { encoding: 'utf8' }).split('\n')[0];
  } catch {
    return null;
  }
}

const version = phpVersion();
if (!version) {
  console.error('php not found on PATH — skipping the oracle comparison.');
  process.exit(0);
}
console.log(`oracle: ${version}\n`);

function deepEqual(a, b, path = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: ${typeof a} vs ${typeof b}`;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9 ? null : `${path}: ${a} vs ${b}`;
  }
  if (a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return `${path}: ${Array.isArray(a) ? 'array' : 'object'} vs ${Array.isArray(b) ? 'array' : 'object'}`;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  const only = (from, other, side) =>
    from.filter((k) => !other.includes(k)).map((k) => `${path}.${k}: only in ${side}`);
  const missing = [...only(keysA, keysB, 'ours'), ...only(keysB, keysA, 'php')];
  if (missing.length > 0) return missing.join('\n');
  for (const key of keysA) {
    const diff = deepEqual(a[key], b[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

const files = [...walk('fixtures')];
let failed = 0;

for (const file of files) {
  const expected = JSON.parse(execFileSync('php', ['scripts/dump.php', file], { encoding: 'utf8' }));

  let actual;
  try {
    actual = parsePhp(readFileSync(file, 'utf8'), file);
  } catch (err) {
    console.log(`FAIL ${file}\n  parser threw: ${err.message}`);
    failed++;
    continue;
  }

  const diff = deepEqual(actual, expected);
  if (diff) {
    console.log(`FAIL ${file}\n  ${diff}`);
    failed++;
  } else {
    const keys = typeof actual === 'object' && actual !== null ? Object.keys(actual).length : 0;
    console.log(`ok   ${file}  (${keys} top-level keys)`);
  }
}

console.log(`\n${files.length - failed}/${files.length} files match PHP`);

// Constructs we intentionally refuse rather than guess at.
const rejects = [
  ['<?php return [ "a" => $var ];', 'variable value'],
  ['<?php return [ "a" => "hi $name" ];', 'interpolation'],
  ['<?php return [ "a" => "x" . "y" ];', 'concatenation'],
  ['<?php return [ "a" => strtoupper("x") ];', 'function call'],
  ['<?php return [ "a" => <<<EOT\nhi\nEOT ];', 'heredoc'],
  ['<?php $x = [];', 'no return'],
  ['<?php return [ "a" => "unterminated ];', 'unterminated string'],
  ['<?php return [ "a" => "x" ]; echo "side effect";', 'trailing statements'],
];

console.log('\nrefusals:');
let refusalFailures = 0;
for (const [source, label] of rejects) {
  try {
    parsePhp(source, '<inline>');
    console.log(`FAIL ${label}: parsed instead of erroring`);
    refusalFailures++;
  } catch (err) {
    console.log(`ok   ${label} -> ${err.message}`);
  }
}

process.exit(failed + refusalFailures > 0 ? 1 : 0);
