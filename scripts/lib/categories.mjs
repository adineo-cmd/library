/**
 * Category names matched here are Wikipedia maintenance scaffolding, not
 * subject matter. Sources are reported verbatim in meta.json and rendered on
 * /method so the heuristic stays auditable.
 *
 * Two rules are anchored to the whole name on purpose: `Films of 1999` is a
 * subject category while `1990s` is maintenance, and the trailing-parenthesis
 * rule is absent so `Mercury (planet)` survives.
 */
export const MAINTENANCE_PATTERNS = [
  '^CS\\d',
  '^WikiProject',
  '^Wikipedia ',
  // \b rather than a literal space: `Template-related` is maintenance too,
  // while `Templateness` is not.
  '^Templates?\\b',
  '^Use dmy',
  '^Articles with ',
  '^Stub',
  '^Undated',
  '^Interwiki',
  '^Commons ',
  '^All ',
  'disambiguation',
  '^(1[89]|20)\\d\\d$',
  '^(1[89]|20)\\d\\ds$',
  '^(1[89]|20)(th|st|nd|rd)\\s+century$',
];

const COMPILED = MAINTENANCE_PATTERNS.map(p => new RegExp(p, 'i'));

export function normalizeCategoryName(raw) {
  return raw.replace(/_/g, ' ').replace(/\s*\(\s*\)\s*$/, '').trim();
}

export function isMaintenanceCategory(name) {
  return COMPILED.some(re => re.test(name));
}