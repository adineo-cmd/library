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
  // Three families measured against the category table itself. Each is
  // `^`-anchored and closes on itself, so a child that keeps the prefix is
  // dropped with its parent rather than orphaned.
  '^Redirects\\b', // 1,784 rows the rules above miss; `Redirects from moves` alone is 3,076,584 pages
  '^(Start|Stub|Edu|C)-Class .* (articles|pages)$', // 4,004 rows; `Start-Class biography articles` is 871,935 pages
  '^Wikipedians who ', // 1,026 rows of user bookkeeping
];

const COMPILED = MAINTENANCE_PATTERNS.map(p => new RegExp(p, 'i'));

export function normalizeCategoryName(raw) {
  return raw.replace(/_/g, ' ').replace(/\s*\(\s*\)\s*$/, '').trim();
}

export function isMaintenanceCategory(name) {
  return COMPILED.some(re => re.test(name));
}