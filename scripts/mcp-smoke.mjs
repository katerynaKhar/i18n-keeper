// Throwaway smoke test: drives the stdio server the way a real MCP client would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'] }),
);

const { tools } = await client.listTools();
console.log('=== tools/list ===');
for (const t of tools) {
  console.log(`${t.name}  in:[${Object.keys(t.inputSchema?.properties ?? {}).join(',')}]  out:${t.outputSchema ? 'yes' : 'no'}`);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  if (res.isError) console.log('isError: true');
  for (const c of res.content ?? []) if (c.type === 'text') console.log(c.text);
  if (res.structuredContent) {
    console.log('-- structuredContent keys:', Object.keys(res.structuredContent).join(', '));
  }
  return res;
}

await call('i18n_scan', { path: 'fixtures/demo' });
await call('i18n_status', { path: 'fixtures/demo' });
await call('i18n_check', { path: 'fixtures/demo', limit: 4 });
await call('i18n_check', { path: 'fixtures/demo', limit: 4, offset: 4 });
await call('i18n_check', { path: 'fixtures/demo', locale: ['pl'], severity: 'error' });
await call('i18n_check', { path: 'fixtures/demo', rule: ['placeholder_missing'] });
const clean = await call('i18n_check', {
  path: 'fixtures/demo',
  locale: ['es'],
  severity: 'error',
});
console.log('\nes errors ->', JSON.stringify(clean.structuredContent));
await call('i18n_check', { path: 'fixtures/nowhere' });
await call('i18n_check', { path: 'fixtures/demo', rule: ['not_a_rule'] });

await client.close();
