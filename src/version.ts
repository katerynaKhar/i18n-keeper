import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The single place the version comes from.
 *
 * It used to be typed out in the CLI and again in the MCP server, and both
 * still said 0.1.0 eleven releases later — a number nobody thinks to update
 * because nothing breaks when they don't. Reading the manifest removes the
 * choice.
 */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/version.js -> the package root, which always ships package.json.
  const manifest = join(here, '..', 'package.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === 'string' && version !== '') return version;
  } catch {
    // An install that lost its manifest still runs; it just cannot say which.
  }
  return 'unknown';
}

export const VERSION = readVersion();
