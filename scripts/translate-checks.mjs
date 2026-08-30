// The translation loop, driven by a stub client: no network, no spend.
//
// What matters here is not the model output but the gate around it — every
// proposal goes back through the deterministic checks, and only clean ones are
// written.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { check } from '../dist/check.js';
import { loadGlossary, glossaryPath } from '../dist/glossary.js';
import { loadLimits, limitsPath } from '../dist/lengths.js';
import { detectProject, loadBundle } from '../dist/scan.js';
import { collectJobs, runTranslation, validate } from '../dist/translate.js';
import { applyProposals } from '../dist/apply.js';

const ROOT = 'fixtures/.translate';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/locales`, { recursive: true });
mkdirSync(`${ROOT}/.i18n`, { recursive: true });

writeFileSync(
  `${ROOT}/locales/en.json`,
  JSON.stringify(
    {
      cart: {
        empty: 'Your cart is empty',
        total: 'Total: {{amount}}',
        checkout: 'Proceed to checkout',
      },
      nav: { subscribe: 'Subscribe' },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(`${ROOT}/locales/fr.json`, JSON.stringify({ cart: {} }, null, 2) + '\n');
writeFileSync(
  `${ROOT}/.i18n/glossary.json`,
  JSON.stringify(
    { version: 1, doNotTranslate: [], terms: [{ source: 'cart', targets: { fr: ['panier'] } }] },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  `${ROOT}/.i18n/limits.json`,
  JSON.stringify({ version: 1, keys: { 'nav.subscribe': 12 } }, null, 2) + '\n',
);

const config = detectProject(ROOT);
const glossary = loadGlossary(glossaryPath(config.root));
const limits = loadLimits(limitsPath(config.root));
const source = loadBundle(config, config.sourceLocale);
const report = check(config, null, glossary, limits);
const jobs = collectJobs(config, report.findings, source, glossary, limits, ['fr']);

console.log('=== work list ===');
for (const job of jobs) {
  const bits = [];
  if (job.placeholders.length) bits.push(`placeholders ${job.placeholders.join(',')}`);
  if (job.glossary.length) bits.push(`glossary ${job.glossary.map((g) => g.term).join(',')}`);
  if (job.maxWidth !== null) bits.push(`max ${job.maxWidth} columns`);
  console.log(`  ${job.reason.padEnd(8)} ${job.key.padEnd(16)} ${bits.join('  ')}`);
}

console.log('\n=== validate() in isolation ===');
const totalJob = jobs.find((j) => j.key === 'cart.total');
const emptyJob = jobs.find((j) => j.key === 'cart.empty');
const cases = [
  [totalJob, 'Total : {{amount}}', 'clean'],
  [totalJob, 'Total :', 'placeholder dropped'],
  [totalJob, 'Total : {{montant}}', 'placeholder renamed'],
  [emptyJob, 'Votre panier est vide', 'glossary satisfied'],
  [emptyJob, 'Votre chariot est vide', 'glossary violated'],
  [emptyJob, '', 'empty'],
];
for (const [job, text, label] of cases) {
  const problems = validate(config, job, text, glossary);
  console.log(
    `  ${(problems.length ? 'reject' : 'accept').padEnd(7)} ${label.padEnd(22)} ${problems.join('; ') || '-'}`,
  );
}

/** Stands in for client.messages.parse. */
function stubClient(scenario) {
  let call = 0;
  return {
    messages: {
      async parse(params) {
        call++;
        const payload = JSON.parse(params.messages[0].content);
        return {
          stop_reason: 'end_turn',
          parsed_output: {
            translations: payload.strings.map((spec) => ({
              id: spec.id,
              text: scenario(spec, call),
            })),
          },
        };
      },
    },
  };
}

const FIRST = {
  'Your cart is empty': 'Votre chariot est vide', // breaks the glossary
  'Total: {{amount}}': 'Total :', // drops the placeholder
  'Proceed to checkout': 'Passer à la caisse',
  Subscribe: "S'abonner à la newsletter", // too wide
};
const RETRY = {
  'Your cart is empty': 'Votre panier est vide', // fixed
  'Total: {{amount}}': 'Total : {{amount}}', // fixed
  Subscribe: "S'abonner à la lettre d'information", // still too wide
};

console.log('\n=== runTranslation with retry ===');
const run = await runTranslation(config, jobs, glossary, {
  model: 'stub',
  effort: 'medium',
  batchSize: 10,
  client: stubClient((spec, call) => (call === 1 ? FIRST[spec.source] : RETRY[spec.source]) ?? ''),
  onBatch: (locale, size, attempt) =>
    console.log(`  request: ${locale}, ${size} strings${attempt > 1 ? ' (retry)' : ''}`),
});

console.log(`  aborted: ${run.aborted ?? 'no'}`);
for (const p of run.proposals) {
  console.log(`  ${(p.accepted ? 'accept' : 'REJECT').padEnd(7)} ${p.key.padEnd(16)} ${p.value}`);
  for (const r of p.rejections) console.log(`          ! ${r}`);
}

console.log('\n=== applyProposals writes only the accepted ones ===');
const applied = applyProposals(config, source, run.proposals);
console.log(`  written ${applied.written}, files ${applied.files.length}`);
console.log(
  readFileSync(`${ROOT}/locales/fr.json`, 'utf8')
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
    .trimEnd(),
);

console.log('\n=== a refusal is per batch: reported, and the run continues ===');
const refusing = {
  messages: {
    async parse() {
      return { stop_reason: 'refusal', stop_details: { category: 'cyber' }, parsed_output: null };
    },
  },
};
const refusedRun = await runTranslation(config, jobs.slice(0, 1), glossary, {
  model: 'stub',
  effort: 'medium',
  batchSize: 10,
  client: refusing,
});
for (const p of refusedRun.proposals) {
  console.log(`  ${p.accepted ? 'accept' : 'REJECT'}  ${p.rejections[0]}`);
}
console.log(`  aborted: ${refusedRun.aborted ?? 'no'}`);

console.log('\n=== anything else stops the run instead of blaming every string ===');
const broken = {
  messages: {
    async parse() {
      throw new Error('Could not resolve authentication method');
    },
  },
};
const abortedRun = await runTranslation(config, jobs, glossary, {
  model: 'stub',
  effort: 'medium',
  batchSize: 10,
  client: broken,
});
console.log(`  proposals: ${abortedRun.proposals.length} (nothing blamed on the local checks)`);
console.log(`  aborted:   ${abortedRun.aborted}`);

rmSync(ROOT, { recursive: true, force: true });
