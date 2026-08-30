// Smoke test: drives the stdio server the way a real MCP client would,
// through the full memory lifecycle on a scratch copy of the demo fixture.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WORK = 'fixtures/.mcp-smoke';
rmSync(WORK, { recursive: true, force: true });
cpSync('fixtures/demo', WORK, { recursive: true });

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'] }),
);

const { tools } = await client.listTools();
console.log('=== tools/list ===');
for (const t of tools) {
  const read = t.annotations?.readOnlyHint === false ? 'writes' : 'read-only';
  console.log(`${t.name}  ${read}  out:${t.outputSchema ? 'yes' : 'no'}`);
}

async function call(name, args, label) {
  const res = await client.callTool({ name, arguments: { path: WORK, ...args } });
  console.log(`\n=== ${label ?? name} ===`);
  if (res.isError) console.log('isError: true');
  for (const c of res.content ?? []) if (c.type === 'text') console.log(c.text);
  return res;
}

function editLocale(locale, mutate) {
  const file = `${WORK}/locales/${locale}.json`;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mutate(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

await call('i18n_scan', {}, 'scan (before any memory exists)');
await call('i18n_status', {}, 'status without memory');
await call('i18n_sync', {}, 'sync: first adoption');
await call('i18n_scan', {}, 'scan (memory now present)');

editLocale('en', (d) => {
  d.cart.checkout = 'Go to checkout';
  d.nav.account = 'Your account';
});

const stale = await call('i18n_check', { rule: ['stale'] }, 'check after the source moved');
console.log('-- structured:', JSON.stringify(stale.structuredContent?.findings?.length), 'findings');

await call('i18n_check', { locale: ['fr'], rule: ['stale'] }, 'check: one locale');
await call('i18n_check', { severity: 'error', limit: 3 }, 'check: errors only, first page');
await call('i18n_check', { severity: 'error', limit: 3, offset: 3 }, 'check: errors only, page 2');
await call('i18n_check', { noMemory: true, rule: ['stale'] }, 'check with noMemory: stale unknowable');
await call('i18n_sync', { force: true }, 'sync --force accepts everything');
await call('i18n_check', { rule: ['stale'] }, 'check: nothing stale again');

await call('i18n_check', { memory: 'nope.json' }, 'error: missing explicit memory');
await call('i18n_check', { rule: ['not_a_rule'] }, 'error: bad rule');

await client.close();
rmSync(WORK, { recursive: true, force: true });
