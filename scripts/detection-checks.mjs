// What a real project taught the scanner. Both cases come from running the
// linter over Laravel-Lang, where it had been silently checking nothing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { detectProject, loadBundle } from '../dist/scan.js';

const ROOT = 'fixtures/.detection';

function project(name, files) {
  const root = `${ROOT}/${name}`;
  rmSync(root, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const full = `${root}/${path}`;
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const check = (label, condition) => console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`);

const laravelJson = JSON.stringify({ accepted: 'The :attribute must be accepted.' }, null, 2);

console.log('=== Laravel keeps string-keyed translations in JSON ===');
{
  // No .php file anywhere, yet the placeholders are Laravel's.
  const root = project('composer', {
    'composer.json': '{"name":"acme/app"}',
    'locales/en.json': laravelJson,
    'locales/pl.json': JSON.stringify({ accepted: 'Pole musi zostać zaakceptowane.' }, null, 2),
  });
  const config = detectProject(root);
  check('composer.json turns :name on', config.placeholderSyntaxes.includes('laravel'));

}

{
  const root = project('lang-dir', {
    'lang/en.json': laravelJson,
    'lang/pl.json': JSON.stringify({ accepted: 'Pole musi zostać zaakceptowane.' }, null, 2),
  });
  check("a lang/ directory turns it on too", detectProject(root).placeholderSyntaxes.includes('laravel'));
}

{
  const root = project('plain-json', {
    'locales/en.json': JSON.stringify({ note: 'Warning:Important' }, null, 2),
    'locales/pl.json': JSON.stringify({ note: 'Uwaga:Ważne' }, null, 2),
  });
  check(
    'a plain JSON project leaves it off',
    !detectProject(root).placeholderSyntaxes.includes('laravel'),
  );
}

console.log('\n=== a file whose root is a list is not a locale file ===');
{
  const root = project('list-file', {
    'locales/en/messages.json': JSON.stringify({ hello: 'Hello' }, null, 2),
    'locales/en/_excludes.json': JSON.stringify(['Afghanistan', 'Angola'], null, 2),
    'locales/pl/messages.json': JSON.stringify({ hello: 'Cześć' }, null, 2),
    'locales/pl/_excludes.json': JSON.stringify(['Afganistan'], null, 2),
  });
  const config = detectProject(root);
  const source = loadBundle(config, 'en');

  check('its keys are not collected', ![...source.leaves.keys()].some((k) => k.includes('_excludes')));
  check('the real file still is', source.leaves.has('messages.hello'));
  check('and it is named rather than ignored', source.skipped.length === 1);
  console.log(`       ${source.skipped[0]?.reason}`);

  // The table always has an "orphan" column, so count the findings instead.
  let report;
  try {
    report = JSON.parse(
      execFileSync(process.execPath, ['dist/cli.js', 'check', root, '--json'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    );
  } catch (err) {
    report = JSON.parse(err.stdout);
  }
  check(
    'so a differing list length is not reported as orphans',
    report.findings.every((f) => f.rule !== 'orphan_key'),
  );
}

rmSync(ROOT, { recursive: true, force: true });
