// The committed fixtures are the tool's own regression baseline: each one is
// meant to end in a known state, so the exit code is asserted rather than
// eyeballed.
import { execFileSync } from 'node:child_process';

// 1 = the linter found an error, 0 = clean.
const EXPECTED = {
  demo: 1,
  laravel: 1,
  plurals: 1,
  glossary: 0,
  lengths: 0,
  gettext: 1,
  rails: 0,
  nested: 1,
};

let failed = 0;

for (const [fixture, expected] of Object.entries(EXPECTED)) {
  let code = 0;
  try {
    execFileSync(process.execPath, ['dist/cli.js', 'check', `fixtures/${fixture}`], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    code = err.status ?? -1;
  }

  const ok = code === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${fixture.padEnd(10)} exit ${code} (expected ${expected})`);
}

console.log(`\n${Object.keys(EXPECTED).length - failed}/${Object.keys(EXPECTED).length} fixtures`);
process.exit(failed > 0 ? 1 : 0);
