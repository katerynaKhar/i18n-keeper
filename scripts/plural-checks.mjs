// Isolated checks for the CLDR/ICU layer before it is wired into the linter.
import { categoriesFor, scanIcu, pipeSegments, pluralGroups } from '../dist/plurals.js';

console.log('=== categoriesFor: known, regional, and unknown tags ===');
for (const loc of ['en', 'pl', 'ja', 'ar', 'pt_BR', 'zh-Hans', 'zz', 'klingon', 'not a tag']) {
  const set = categoriesFor(loc);
  console.log(`${loc.padEnd(12)} -> ${set ? [...set].join(',') : 'unknown (skipped)'}`);
}

console.log('\n=== scanIcu ===');
const messages = [
  '{count, plural, one {# item} other {# items}}',
  '{count, plural, offset:1 =0 {none} =1 {just one} one {#} other {#}}',
  '{count, plural, one {{gender, select, male {he} other {they}}} other {#}}',
  'You have {count, plural, one {# message} other {# messages}} today',
  '{{count}} items',
  'Hello {name}, you have {n, number} points',
  '{gender, select, male {he} female {she} other {they}}',
  "It's a plain string with an apostrophe",
  "Literal '{' brace and '}' brace",
  '{count, plural, one {# item} other {# items}',
  '{count, plural, one # item other}',
  '{count, plural, }',
  'no braces at all',
  '}unbalanced{',
];
for (const m of messages) {
  const { blocks, error } = scanIcu(m);
  const summary = blocks
    .map((b) => `${b.type}(${b.arg}): ${[...b.categories, ...b.exact].join('|') || '-'}`)
    .join('  ');
  console.log(`${JSON.stringify(m).slice(0, 62).padEnd(64)} ${error ? `ERR ${error}` : summary || '(none)'}`);
}

console.log('\n=== pluralGroups: both conventions, and what is not a group ===');
const keySets = {
  'i18next suffixes': ['item_one', 'item_other', 'item_few'],
  'Rails nesting': ['items.one', 'items.other'],
  'not plurals': ['nav.home', 'snake_case_key', 'file_name'],
  'a lone non-other sibling': ['numbers.one'],
  'a lone other is still a group': ['files.other'],
  'mixed in one file': ['msg_zero', 'msg_two', 'msg_many', 'card.one', 'card.other'],
};
for (const [label, keys] of Object.entries(keySets)) {
  const groups = pluralGroups(keys);
  const shown = [...groups.entries()]
    .map(([base, g]) => `${base}${g.separator}* {${[...g.categories].join(',')}}`)
    .join('  ');
  console.log(`  ${label.padEnd(28)} -> ${shown || '(no groups)'}`);
}

console.log('\n=== pipeSegments (Laravel) ===');
for (const s of [
  'apple|apples',
  '{0} none|[1,19] some|[20,*] many',
  'no pipes here',
  'a|b|c',
  'ranges {0,1} together|rest',
]) {
  console.log(`${JSON.stringify(s).padEnd(40)} -> ${pipeSegments(s)}`);
}
