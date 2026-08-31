// Repair jobs: translations that exist and are provably wrong.
// Stub client throughout — no network, no spend.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { check } from '../dist/check.js';
import { loadGlossary, glossaryPath } from '../dist/glossary.js';
import { loadLimits, limitsPath } from '../dist/lengths.js';
import { detectProject, loadBundle } from '../dist/scan.js';
import { collectJobs, runTranslation, REPAIRABLE_RULES } from '../dist/translate.js';

const ROOT = 'fixtures/.repair';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });
mkdirSync(`${ROOT}/.i18n`, { recursive: true });

const en = {
  cart: { total: 'Total: {{amount}}', empty: 'Your cart is empty' },
  order: { thanks: 'Thanks, {{name}}!' },
  nav: { subscribe: 'Subscribe to newsletter' },
  msg: { count: '{count, plural, one {# item} other {# items}}' },
  ok: { fine: 'Save' },
};

// Every value below is wrong in a different, checkable way — except ok.fine.
const pl = {
  cart: { total: 'Razem:', empty: 'Twój wózek jest pusty' },
  order: { thanks: 'Dziękujemy, {{imie}}!' },
  nav: { subscribe: 'Subskrybuj biuletyn informacyjny' },
  msg: { count: '{count, plural, one {# produkt} other {# produktów}}' },
  ok: { fine: 'Zapisz' },
};

writeFileSync(`${ROOT}/locales/en.json`, JSON.stringify(en, null, 2) + '\n');
writeFileSync(`${ROOT}/locales/pl.json`, JSON.stringify(pl, null, 2) + '\n');
writeFileSync(
  `${ROOT}/.i18n/glossary.json`,
  JSON.stringify(
    { version: 1, doNotTranslate: [], terms: [{ source: 'cart', targets: { pl: ['koszyk'] } }] },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  `${ROOT}/.i18n/limits.json`,
  JSON.stringify({ version: 1, keys: { 'nav.subscribe': 14 } }, null, 2) + '\n',
);

console.log('=== repairable rules ===');
console.log(`  ${[...REPAIRABLE_RULES].join('\n  ')}`);

const config = detectProject(ROOT);
const glossary = loadGlossary(glossaryPath(config.root));
const limits = loadLimits(limitsPath(config.root));
const source = loadBundle(config, config.sourceLocale);
const report = check(config, null, glossary, limits);

const jobs = collectJobs(config, report.findings, source, glossary, limits);

console.log('\n=== work list ===');
for (const job of jobs) {
  console.log(`  ${job.kind.padEnd(8)} ${job.key.padEnd(16)} current: ${JSON.stringify(job.previous)}`);
  for (const problem of job.problems) console.log(`           ! ${problem}`);
}

console.log('\n=== --only repair / --only fill ===');
for (const kind of ['fill', 'repair', 'refresh']) {
  const only = collectJobs(config, report.findings, source, glossary, limits, undefined, [kind]);
  console.log(`  --only ${kind.padEnd(8)} -> ${only.length} job(s)`);
}

// What the model actually receives for a repair.
let seenPayload = null;
function stub(answers) {
  return {
    messages: {
      async parse(params) {
        const payload = JSON.parse(params.messages[0].content);
        seenPayload ??= payload;
        return {
          stop_reason: 'end_turn',
          parsed_output: {
            translations: payload.strings.map((spec) => ({
              id: spec.id,
              text: answers[spec.key] ?? '',
            })),
          },
        };
      },
    },
  };
}

const FIXED = {
  'cart.total': 'Razem: {{amount}}',
  'cart.empty': 'Twój koszyk jest pusty',
  'order.thanks': 'Dziękujemy, {{name}}!',
  'nav.subscribe': 'Zapisz się',
  'msg.count':
    '{count, plural, one {# produkt} few {# produkty} many {# produktów} other {# produktu}}',
};

console.log('\n=== what a repair job looks like on the wire ===');
const run = await runTranslation(config, jobs, glossary, {
  model: 'stub',
  effort: 'medium',
  batchSize: 10,
  client: stub(FIXED),
});
const sample = seenPayload.strings.find((s) => s.key === 'order.thanks');
console.log(JSON.stringify(sample, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));

console.log('\n=== verdicts ===');
for (const p of run.proposals) {
  console.log(`  ${(p.accepted ? 'accept' : 'REJECT').padEnd(7)} ${p.kind.padEnd(8)} ${p.key.padEnd(16)} ${p.value}`);
  for (const r of p.rejections) console.log(`          ! ${r}`);
}

console.log('\n=== a repair that does not actually repair is still rejected ===');
const STILL_BROKEN = { ...FIXED, 'cart.total': 'Razem: teraz' };
const bad = await runTranslation(config, jobs, glossary, {
  model: 'stub',
  effort: 'medium',
  batchSize: 10,
  client: stub(STILL_BROKEN),
});
for (const p of bad.proposals.filter((p) => !p.accepted)) {
  console.log(`  REJECT  ${p.key.padEnd(16)} ${p.value}`);
  for (const r of p.rejections) console.log(`          ! ${r}`);
}

rmSync(ROOT, { recursive: true, force: true });
