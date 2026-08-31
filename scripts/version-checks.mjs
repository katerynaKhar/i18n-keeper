// The version reported anywhere must be the version in the manifest.
// It drifted eleven releases without anyone noticing, because nothing breaks
// when it does — so it is asserted rather than remembered.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERSION } from '../dist/version.js';

const expected = JSON.parse(readFileSync('package.json', 'utf8')).version;
let failed = 0;

const check = (label, actual) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(28)} ${actual}`);
};

console.log(`package.json says ${expected}\n`);

check('the shared constant', VERSION);
check(
  'i18n-keeper --version',
  execFileSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8' }).trim(),
);

const helpLine = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' })
  .split('\n')[0]
  .trim();
check('the help heading', helpLine.replace('i18n-keeper ', ''));

// The MCP server announces its version to every client that connects.
const client = new Client({ name: 'version-check', version: '0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'] }),
);
check('what the MCP server reports', client.getServerVersion()?.version ?? 'missing');
await client.close();

console.log(failed === 0 ? '\nall agree' : `\n${failed} disagree`);
process.exit(failed > 0 ? 1 : 0);
