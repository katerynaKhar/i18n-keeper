import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  containsTerm,
  expectationsFor,
  missingVerbatim,
  type Glossary,
} from './glossary.js';
import { limitFor, measurable, renderedWidth, type Limits } from './lengths.js';
import { categoriesFor, looksLikeIcuPlural, scanIcu } from './plurals.js';
import { diffPlaceholders, extractPlaceholders } from './placeholders.js';
import { loadBundle } from './scan.js';
import type { Config, Finding, LocaleBundle } from './types.js';

/**
 * The one part of this tool that needs a network and cannot be verified by
 * reading the output. So it is not trusted: every proposal is put back through
 * the same deterministic checks the linter already applies, and anything that
 * fails is rejected rather than written.
 */

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_BATCH = 20;
export const DEFAULT_CAP = 50;

export type JobKind = 'fill' | 'repair' | 'refresh';

export const JOB_KINDS: readonly JobKind[] = ['fill', 'repair', 'refresh'];

/** No usable translation exists. */
const FILL_RULES = new Set(['missing_key', 'empty_value']);

/**
 * Defects worth handing back to the model.
 *
 * A rule belongs here only if `validate` can confirm the repair afterwards.
 * That is the whole selection principle: a fix the gate cannot check is a fix
 * nobody can trust, so those findings are left for a human.
 *
 * It excludes `identical_to_source` (often correct — "Email" is "Email" in
 * French, and forcing a change would make it worse), `plural_extra_category`
 * and `plural_selector_lost` (the single-string validator does not check for
 * either, so a repair could not be verified).
 */
export const REPAIRABLE_RULES = new Set([
  'placeholder_missing',
  'placeholder_extra',
  'icu_syntax_error',
  'plural_missing_category',
  'glossary_violation',
  'dnt_violation',
  'length_over_max',
]);

const RANK: Record<JobKind, number> = { fill: 0, repair: 1, refresh: 2 };

export interface Job {
  locale: string;
  key: string;
  source: string;
  kind: JobKind;
  /** The translation being replaced: broken for a repair, outdated for a refresh. */
  previous: string | null;
  /** For a repair, exactly what the linter found wrong. */
  problems: string[];
  placeholders: string[];
  glossary: Array<{ term: string; accepted: string[] }>;
  doNotTranslate: string[];
  maxWidth: number | null;
  isIcuPlural: boolean;
}

export interface Proposal {
  locale: string;
  key: string;
  kind: JobKind;
  source: string;
  value: string;
  accepted: boolean;
  /** Deterministic checks the proposal failed, if any. */
  rejections: string[];
  attempts: number;
}

/** Turns a lint report into a work list. */
export function collectJobs(
  config: Config,
  findings: Finding[],
  source: LocaleBundle,
  glossary: Glossary | null,
  limits: Limits | null,
  locales?: string[],
  kinds?: JobKind[],
): Job[] {
  const wantedLocale = locales && locales.length > 0 ? new Set(locales) : null;
  const wantedKind = kinds && kinds.length > 0 ? new Set(kinds) : null;

  interface Draft {
    locale: string;
    key: string;
    kind: JobKind;
    problems: string[];
  }
  const drafts = new Map<string, Draft>();

  for (const finding of findings) {
    // The source locale is checked too — a broken or oversized source string is
    // reported against it — but there is nothing to translate it into.
    if (finding.locale === config.sourceLocale) continue;
    if (wantedLocale && !wantedLocale.has(finding.locale)) continue;

    let kind: JobKind | null = null;
    if (FILL_RULES.has(finding.rule)) kind = 'fill';
    else if (REPAIRABLE_RULES.has(finding.rule)) kind = 'repair';
    else if (finding.rule === 'stale') kind = 'refresh';
    if (!kind) continue;

    const id = `${finding.locale}\u0000${finding.key}`;
    const draft = drafts.get(id);
    const problem = `${finding.rule}: ${finding.detail}`;

    if (!draft) {
      drafts.set(id, {
        locale: finding.locale,
        key: finding.key,
        kind,
        problems: kind === 'repair' ? [problem] : [],
      });
      continue;
    }

    // One key can be broken several ways at once; collect every reason.
    if (kind === 'repair') draft.problems.push(problem);
    // A defect outranks mere staleness, and a missing string outranks both.
    if (RANK[kind] < RANK[draft.kind]) draft.kind = kind;
  }

  const targets = new Map<string, LocaleBundle>();
  const targetFor = (locale: string): LocaleBundle => {
    let bundle = targets.get(locale);
    if (!bundle) {
      bundle = loadBundle(config, locale);
      targets.set(locale, bundle);
    }
    return bundle;
  };

  const jobs: Job[] = [];
  for (const draft of drafts.values()) {
    if (wantedKind && !wantedKind.has(draft.kind)) continue;

    const sourceLeaf = source.leaves.get(draft.key);
    if (!sourceLeaf || sourceLeaf.value.trim() === '') continue;

    // A group finding such as `item_*` names no real key and is skipped above,
    // which is why only per-string plural defects reach a repair job.
    const previous =
      draft.kind === 'fill' ? null : (targetFor(draft.locale).leaves.get(draft.key)?.value ?? null);

    jobs.push({
      locale: draft.locale,
      key: draft.key,
      source: sourceLeaf.value,
      kind: draft.kind,
      previous: previous === '' ? null : previous,
      problems: draft.problems,
      placeholders: [...extractPlaceholders(sourceLeaf.value, config.placeholderSyntaxes).keys()],
      glossary: glossary
        ? expectationsFor(glossary, draft.locale, sourceLeaf.value).map((e) => ({
            term: e.term.source,
            accepted: e.accepted,
          }))
        : [],
      doNotTranslate: glossary
        ? glossary.doNotTranslate.filter((token) =>
            containsTerm(sourceLeaf.value, token, 'exact', true),
          )
        : [],
      maxWidth: limits ? limitFor(limits, draft.key) : null,
      isIcuPlural: looksLikeIcuPlural(sourceLeaf.value),
    });
  }

  return jobs;
}

/** What `validate` needs to judge a string; a full Job satisfies it. */
export type Constraints = Pick<Job, 'source' | 'locale' | 'maxWidth'>;

/** The same rules the linter enforces, applied to one proposed string. */
export function validate(
  config: Config,
  job: Constraints,
  proposed: string,
  glossary: Glossary | null,
): string[] {
  const problems: string[] = [];

  if (proposed.trim() === '') return ['empty translation'];

  const lost = diffPlaceholders(
    extractPlaceholders(job.source, config.placeholderSyntaxes),
    extractPlaceholders(proposed, config.placeholderSyntaxes),
  );
  if (lost.missing.length > 0) problems.push(`placeholders lost: ${lost.missing.join(', ')}`);
  if (lost.extra.length > 0) problems.push(`placeholders invented: ${lost.extra.join(', ')}`);

  const categories = categoriesFor(job.locale);
  const scan = scanIcu(proposed);
  if (scan.error) {
    problems.push(`malformed ICU: ${scan.error}`);
  } else if (categories) {
    for (const block of scan.blocks) {
      const absent = [...categories].filter((c) => !block.categories.has(c));
      if (absent.length > 0) {
        problems.push(`plural forms missing for ${job.locale}: ${absent.join('/')}`);
      }
    }
  }

  if (glossary) {
    const verbatim = missingVerbatim(glossary, job.source, proposed);
    if (verbatim.length > 0) problems.push(`must stay verbatim: ${verbatim.join(', ')}`);

    for (const { term, accepted } of expectationsFor(glossary, job.locale, job.source)) {
      const ok = accepted.some((form) =>
        containsTerm(proposed, form, term.match, term.caseSensitive),
      );
      if (!ok) {
        problems.push(`"${term.source}" must be rendered as ${accepted.join(' or ')}`);
      }
    }
  }

  if (job.maxWidth !== null && measurable(proposed)) {
    const width = renderedWidth(proposed, config.placeholderSyntaxes.includes('laravel'));
    if (width > job.maxWidth) {
      problems.push(`${width} columns, limit ${job.maxWidth}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

const SYSTEM = `You translate user-interface strings for software localisation.

Rules, in order of priority:
1. Every placeholder in the source must appear in the translation, spelled exactly
   as given. Never translate, reorder away, or invent placeholders.
2. If the source is an ICU message, keep its structure and supply every plural
   category the target language requires.
3. Glossary terms must be rendered with one of the approved forms, inflected as
   the sentence requires.
4. Do-not-translate tokens must appear character for character.
5. Stay within the width limit when one is given; prefer the shortest natural
   wording that is still idiomatic.
6. Match the register and tone of interface copy: concise, direct, no added
   punctuation or explanation.

A string that arrives with \`current_translation\` and \`problems_to_fix\` is a
repair, not a fresh translation. Someone already chose that wording; keep it
wherever it is right and change only what the listed problems require.

Return only the translations. Do not comment on them.`;

const ProposalSchema = z.object({
  translations: z.array(
    z.object({
      id: z.number().int().describe('The id of the string being translated.'),
      text: z.string().describe('The translated string.'),
    }),
  ),
});

function describeJob(job: Job, index: number): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    id: index,
    key: job.key,
    source: job.source,
  };
  if (job.placeholders.length > 0) spec['placeholders_that_must_survive'] = job.placeholders;
  if (job.isIcuPlural) {
    const categories = categoriesFor(job.locale);
    spec['icu_plural'] = true;
    if (categories) spec['required_plural_categories'] = [...categories];
  }
  if (job.glossary.length > 0) {
    spec['glossary'] = job.glossary.map((g) => ({ source_term: g.term, use_one_of: g.accepted }));
  }
  if (job.doNotTranslate.length > 0) spec['do_not_translate'] = job.doNotTranslate;
  if (job.maxWidth !== null) spec['max_display_columns'] = job.maxWidth;
  if (job.previous) {
    spec[job.kind === 'repair' ? 'current_translation' : 'outdated_translation'] = job.previous;
  }
  if (job.problems.length > 0) spec['problems_to_fix'] = job.problems;
  return spec;
}

export interface TranslateOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  client?: Anthropic;
}

/** The model declined one batch on content grounds; other batches may still run. */
export class TranslationRefused extends Error {}

/** One request for one locale's batch. Returns text keyed by job index. */
export async function requestBatch(
  jobs: Job[],
  locale: string,
  options: TranslateOptions,
  feedback?: Map<number, string[]>,
): Promise<Map<number, string>> {
  const client = options.client ?? new Anthropic();

  const payload = {
    target_locale: locale,
    strings: jobs.map((job, index) => {
      const spec = describeJob(job, index);
      const failures = feedback?.get(index);
      if (failures) spec['previous_attempt_was_rejected_because'] = failures;
      return spec;
    }),
  };

  const response = await client.messages.parse({
    model: options.model,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: options.effort,
      format: zodOutputFormat(ProposalSchema),
    },
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? 'unspecified';
    throw new TranslationRefused(`the model declined this batch (${category})`);
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('the model returned no parseable translations');

  const byIndex = new Map<number, string>();
  for (const item of parsed.translations) {
    if (item.id >= 0 && item.id < jobs.length) byIndex.set(item.id, item.text);
  }
  return byIndex;
}

export interface TranslationRun {
  proposals: Proposal[];
  /**
   * Why the run stopped early, if it did. Anything that is not a content
   * refusal — no credentials, a rate limit, a network failure — will hit every
   * remaining batch the same way, so the run stops instead of reporting the
   * same infrastructure error once per string.
   */
  aborted: string | null;
}

export interface RunOptions extends TranslateOptions {
  batchSize: number;
  /** Called before each request so the caller can report progress. */
  onBatch?: (locale: string, size: number, attempt: number) => void;
}

/**
 * Translates a work list, validating every proposal and retrying once with the
 * specific failures handed back to the model.
 */
export async function runTranslation(
  config: Config,
  jobs: Job[],
  glossary: Glossary | null,
  options: RunOptions,
): Promise<TranslationRun> {
  const proposals: Proposal[] = [];

  const byLocale = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = byLocale.get(job.locale);
    if (list) list.push(job);
    else byLocale.set(job.locale, [job]);
  }

  for (const [locale, localeJobs] of byLocale) {
    for (let start = 0; start < localeJobs.length; start += options.batchSize) {
      const batch = localeJobs.slice(start, start + options.batchSize);

      options.onBatch?.(locale, batch.length, 1);
      let results: Map<number, string>;
      try {
        results = await requestBatch(batch, locale, options);
      } catch (err) {
        if (!(err instanceof TranslationRefused)) {
          return { proposals, aborted: err instanceof Error ? err.message : String(err) };
        }
        for (const job of batch) {
          proposals.push({
            locale,
            key: job.key,
            kind: job.kind,
            source: job.source,
            value: '',
            accepted: false,
            rejections: [err.message],
            attempts: 1,
          });
        }
        continue;
      }

      const verdicts = batch.map((job, index) => {
        const value = results.get(index) ?? '';
        return { job, index, value, problems: value ? validate(config, job, value, glossary) : ['no translation returned'] };
      });

      // One retry, telling the model exactly which rule each string broke.
      const failed = verdicts.filter((v) => v.problems.length > 0);
      if (failed.length > 0) {
        const retryJobs = failed.map((v) => v.job);
        const feedback = new Map<number, string[]>();
        failed.forEach((v, position) => feedback.set(position, v.problems));

        options.onBatch?.(locale, retryJobs.length, 2);
        try {
          const retried = await requestBatch(retryJobs, locale, options, feedback);
          failed.forEach((v, position) => {
            const value = retried.get(position);
            if (!value) return;
            const problems = validate(config, v.job, value, glossary);
            if (problems.length === 0) {
              v.value = value;
              v.problems = [];
            } else {
              v.value = value;
              v.problems = problems;
            }
          });
        } catch (err) {
          if (!(err instanceof TranslationRefused)) {
            for (const verdict of verdicts) {
              proposals.push({
                locale,
                key: verdict.job.key,
                kind: verdict.job.kind,
                source: verdict.job.source,
                value: verdict.value,
                accepted: verdict.problems.length === 0,
                rejections: verdict.problems,
                attempts: 2,
              });
            }
            return { proposals, aborted: err instanceof Error ? err.message : String(err) };
          }
          // A refusal on the retry keeps the first-attempt rejections, which
          // are the more useful report.
        }
      }

      for (const verdict of verdicts) {
        proposals.push({
          locale,
          key: verdict.job.key,
          kind: verdict.job.kind,
          source: verdict.job.source,
          value: verdict.value,
          accepted: verdict.problems.length === 0,
          rejections: verdict.problems,
          attempts: failed.includes(verdict) ? 2 : 1,
        });
      }
    }
  }

  return { proposals, aborted: null };
}
