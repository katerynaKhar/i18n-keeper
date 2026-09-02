/**
 * The library surface.
 *
 * The CLI and the MCP server are two front ends over the same functions; this
 * is the third door, for anything that wants to embed the checks — an editor
 * plugin, a CI script, another tool. Only what a caller outside this package
 * can reasonably need is re-exported: everything here is either used by the
 * CLI or required to describe what it returns.
 */

export { check } from './check.js';
export { detectProject, loadBundle, sourceIsMsgid, ScanError } from './scan.js';
export type { DetectOptions } from './scan.js';

export { glossaryPath, loadGlossary, GlossaryError } from './glossary.js';
export type { Glossary } from './glossary.js';

export { limitsPath, loadLimits, LimitsError } from './lengths.js';
export type { Limits } from './lengths.js';

export { emptyMemory, loadMemory, memoryPath, MemoryError } from './memory.js';
export type { Memory } from './memory.js';

export { FormatError, describeFormatError } from './formats/error.js';

export { DEFAULT_RULES, RULE_IDS } from './types.js';
export type {
  Config,
  Finding,
  LocaleBundle,
  LocaleStat,
  Report,
  RuleId,
  RuleSetting,
  Severity,
} from './types.js';

export { ALL_SYNTAXES, DEFAULT_SYNTAXES, extractPlaceholders } from './placeholders.js';
export { categoriesFor, splitPluralSuffix } from './plurals.js';

export { VERSION } from './version.js';
