import { describe, it, expect } from 'vitest';
import {
  isMaintenanceCategory, normalizeCategoryName, MAINTENANCE_PATTERNS,
} from '../categories.mjs';

describe('normalizeCategoryName', () => {
  it('converts underscores to spaces and trims', () => {
    expect(normalizeCategoryName('Physical_sciences')).toBe('Physical sciences');
  });
  it('leaves a clean name alone', () => {
    expect(normalizeCategoryName('Thermodynamics')).toBe('Thermodynamics');
  });
  it('strips empty parentheses left by redirects', () => {
    expect(normalizeCategoryName('Foo ()')).toBe('Foo');
  });
});

describe('isMaintenanceCategory', () => {
  const kept = [
    'Physics', 'Thermodynamics', 'History of science',
    'Films of 1999', 'Association football', 'Mathematics',
    'Music theory', 'Mercury (planet)',
  ];
  const dropped = [
    'CS1 references', 'CS1 talk: inc', 'WikiProject Physics',
    'Wikipedia articles needing clarification', 'Template-related',
    'Use dmy dates', 'Articles with short description', 'Stubs',
    'Undated stubs needing attention', 'Interwiki', 'Commons category',
    '1900', '1990s', '20th century', 'All stub articles',
  ];

  it.each(kept)('keeps %s', name => expect(isMaintenanceCategory(name)).toBe(false));
  it.each(dropped)('drops %s', name => expect(isMaintenanceCategory(name)).toBe(true));
});

/**
 * Ruling 2. Every title below is a real `cat_title` read out of
 * `enwiki-latest-category.sql.gz`, so the fixtures cannot drift from the dump.
 */
describe('isMaintenanceCategory — the three ruled meta-filter families', () => {
  const dropped = [
    // `^Redirects\b` — redirect bookkeeping. 1,784 rows past the shipped rules,
    // led by `Redirects from moves` at 3,076,584 pages.
    'Redirects from moves', 'Redirects to sections', 'Redirects from merges',
    // `^(Start|Stub|Edu|C)-Class .* (articles|pages)$` — WikiProject quality
    // assessment. 4,004 rows past the shipped rules (the `Stub-Class` half is
    // already caught by `^Stub`); `Start-Class biography articles` alone holds
    // 871,935 pages. No `Edu-Class` row exists in the dump today.
    'Start-Class biography articles', 'C-Class biography articles',
    'Start-Class football articles', 'C-Class United States articles',
    // `^Wikipedians who ` — user bookkeeping. 1,026 rows past the shipped rules,
    // led by `Wikipedians who have received a Teahouse invitation` (443,091).
    'Wikipedians who have received a Teahouse invitation',
    'Wikipedians who like Futurama', 'Wikipedians who use Mozilla Firefox',
  ];
  const kept = [
    // `\b` stops the rule one character early, and the `(articles|pages)$` tail
    // stops it early, so neither reaches a subject that shares the shape.
    'Redirect', 'Redirection', 'E-Class (Mercedes-Benz)', 'Class of 1999',
    'Wikipedians', 'Wikipedian editors',
  ];

  it.each(dropped)('drops %s', name => expect(isMaintenanceCategory(name)).toBe(true));
  it.each(kept)('keeps %s', name => expect(isMaintenanceCategory(name)).toBe(false));
});

describe('MAINTENANCE_PATTERNS', () => {
  /**
   * One real dump title per pattern, covering all of them. Every entry was read
   * out of `enwiki-latest-category.sql.gz` while measuring the table, so this
   * list is evidence rather than invention — and the assertion below turns it
   * into a gate.
   *
   * The gate exists because a pattern that matches no real row is invisible to a
   * unit test and dead in production, yet `/method` renders the whole list
   * verbatim as if every entry were doing work. An earlier revision shipped
   * `^[A-Z]-importance `, which matches 0 of 2.6M rows: the real titles are
   * `NA-importance`, `Low-importance` and so on. Adding a pattern without adding
   * its exemplar now fails here.
   */
  const REAL_EXEMPLARS = [
    'CS1 errors: ISSN',
    'WikiProject Canadian communities articles',
    'Wikipedia articles needing clarification',
    'Template documentation',
    'Use dmy dates',
    'Articles with unsourced statements',
    'Stub-Class biography (politics and government) articles',
    'Undated AfC submissions',
    'Interwiki category linking templates',
    'Commons category Wikidata tracking categories',
    'All articles with unsourced statements',
    'Disambiguation pages in need of cleanup',
    '1978',
    '1920s',
    '18th century',
    'Redirects from merges',
    'Start-Class biography articles',
    'Wikipedians who listen to world music',
  ];

  it('is the auditable list reported on /method', () => {
    expect(MAINTENANCE_PATTERNS.length).toBeGreaterThan(0);
    for (const source of MAINTENANCE_PATTERNS) {
      expect(() => new RegExp(source, 'i')).not.toThrow();
    }
  });

  it('has no dead pattern: every one is exercised by a real dump title', () => {
    const orphans = MAINTENANCE_PATTERNS.filter(
      source => !REAL_EXEMPLARS.some(title => new RegExp(source, 'i').test(title)));
    expect(orphans).toEqual([]);
  });

  it('keeps a fixture only for patterns that exist', () => {
    // The reverse direction: a stale exemplar is a test asserting nothing.
    const stale = REAL_EXEMPLARS.filter(
      title => !MAINTENANCE_PATTERNS.some(source => new RegExp(source, 'i').test(title)));
    expect(stale).toEqual([]);
  });

  it('does not swallow disambiguated names on the trailing parenthesis', () => {
    expect(MAINTENANCE_PATTERNS.some(p => new RegExp(p, 'i').test('Mercury (planet)')))
      .toBe(false);
  });

  it('does not swallow every decade-shaped name', () => {
    // The decade rule is anchored to the whole name: "1990s" is maintenance,
    // "Films of 1999" is a subject category.
    expect(isMaintenanceCategory('Films of 1999')).toBe(false);
    expect(isMaintenanceCategory('1960s in jazz')).toBe(false);
    expect(isMaintenanceCategory('1990s')).toBe(true);
  });
});