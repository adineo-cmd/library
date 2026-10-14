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

/**
 * Ruling 3. Every title below is a real `cat_title` read out of
 * `enwiki-latest-category.sql.gz`, so the fixtures cannot drift from the dump.
 * These are the families that owned the top of the 30,000-node cut.
 */
describe('isMaintenanceCategory — the top-of-cut families', () => {
  const dropped = [
    // Service sync. `Short description is different from Wikidata` was node #1
    // of the whole cut at 4,673,004 pages; `Coordinates on Wikidata` was #7.
    'Short description is different from Wikidata', 'Short description matches Wikidata',
    'Short description with empty Wikidata description', 'Coordinates on Wikidata',
    'Official website not in Wikidata',
    // Redirect / index bookkeeping.
    'Unprintworthy redirects', 'Printworthy redirects', 'Avoided double redirects',
    'Middle-earth redirects', 'Noindexed pages',
    // Tool-usage and template-parameter reports.
    'Pages using gadget WikiMiniAtlas', 'Pages using the Kartographer extension',
    'Pages using infobox settlement with no coordinates',
    'Articles using NRISref without a reference number',
    'Single chart called without song', 'Album chart usages for Billboard200',
    'Automatic category TOC generates no TOC',
    'Film articles needing an image', 'Biography articles needing infoboxes',
    'Military history articles needing attention to referencing and citation',
    'Television episode articles with short description for single episodes',
    'Interlanguage link template existing link', 'Taxonbars desynced from Wikidata',
    'Set categories', 'Pages including recorded pronunciations',
    'Pages translated from German Wikipedia', 'Wayback template wayback links',
    'Category series navigation using skip-gaps parameter', 'Container categories',
    'Tracking categories', 'Infobox road maps tracking category',
    // WikiProject assessment.
    'Category-Class Years pages', 'List-Class List articles', 'NA-importance Years pages',
    'Mid-importance football articles', 'Low-importance Lepidoptera articles',
    'Sports and games work group articles', 'European military history task force articles',
    'Military history articles by task force', 'Harry Potter task force participants',
    'Good articles', 'Featured articles',
    // The living-people bot family. Dropped on a product decision, not a
    // heuristic: a human partner ruled these are template bookkeeping.
    'Biography articles of living people', 'Living people',
    'Year of birth missing (living people)', 'Place of birth missing (living people)',
    // User-space administration.
    'User talk pages with Uw-spam1 notices', 'User en-N', 'Male Wikipedians',
    'Paid contributors', 'Users tagged as sockpuppets with no second parameter',
    'Local COIBot Reports', 'Shared IP addresses from educational institutions',
    'Ended featured picture nominations', 'Userboxes with insufficient color contrast',
    // Article-creation queues and dated cleanup buckets.
    'Accepted AfC submissions', 'Declined AfC submissions',
    'Taxonomy articles created by Polbot', 'Use American English from July 2025',
    'Articles of WikiProject Protected areas',
    // Media licensing.
    'Non-free rationale as na', 'Creative Commons Attribution-ShareAlike 3.0 files',
    'GFDL files', 'Album covers', 'Files with no machine-readable description',
    'Navboxes using background colours', 'Automatically assessed biography articles',
    'Pages within the scope of WikiProject Astronomical objects (WP Astronomy Banner)',
  ];

  /**
   * The over-reach guard, and the reason this round exists. Each of these is a
   * real `cat_title` that a plausible-looking but wrong pattern would have
   * deleted — `First-class cricket` is the `-Class` family meeting a subject,
   * `Use of force` and `Chemical compounds and Wikidata` are the two shapes
   * that made the naive `^Use ` and bare `Wikidata` rules wrong.
   */
  const kept = [
    'Physics', 'History', 'Geography', 'Mathematics', 'Thermodynamics',
    'Films of 1999', 'Mercury (planet)', 'Association football', 'Music theory',
    'Men’s association football midfielders', 'Surnames', 'Given names',
    'Named minor planets', 'IUCN Red List least concern species',
    'Active politicians', 'Albums by artist', '1988 births', 'Latin music',
    // Shape collisions, all real dump titles.
    'First-class cricket teams in India', 'First-class cricket competitions',
    'Cat-Class articles', 'Use of force', 'Use of electoral systems',
    'Chemical compounds and Wikidata', 'Male actors in Hindi cinema',
    'Creative Commons-licensed novels', 'English-language films',
    'Media and communications in Barnet', 'File hosting', 'E-Class (Mercedes-Benz)',
    'Taxonomy', 'Awards', 'Royalty and nobility', 'Pop music',
  ];

  it.each(dropped)('drops %s', name => expect(isMaintenanceCategory(name)).toBe(true));
  it.each(kept)('keeps %s', name => expect(isMaintenanceCategory(name)).toBe(false));
});

describe('MAINTENANCE_PATTERNS', () => {
  /**
   * One real `cat_title` per pattern, in the same order as
   * `MAINTENANCE_PATTERNS`, read out of `enwiki-latest-category.sql.gz`. Every
   * entry is a title that its own pattern matches **and that no earlier
   * pattern in the list matches** — so each pattern demonstrably contributes
   * coverage the list did not already have.
   *
   * The exclusivity is the whole point. A plain "does any fixture match this
   * pattern" check passes for a pattern that matches nothing of its own
   * because some other pattern happens to match the fixture, which is how
   * `^[A-Z]-importance ` shipped dead once and how a second dead rule
   * (`^Wayback template `, 0 rows — the real title is `Wayback template
   * wayback links`) survived a review round. Requiring an earlier-unclaimed
   * title closes that hole: a redundant or empty pattern has nowhere to point.
   *
   * Adding a pattern without adding its exemplar fails on length; adding an
   * exemplar that some earlier pattern already claims fails on exclusivity.
   */
  const EXCLUSIVE_EXEMPLARS = [
    'CS1 maint: deprecated archival service',
    'WikiProject Biography articles',
    'Wikipedia non-free files with NFUR stated',
    'Template film date with 1 release date',
    'Use dmy dates from April 2022',
    'Articles with short description',
    'Stub-Class biography articles',
    'Undated AfC submissions',
    'Interwiki bots',
    'Commons category link is on Wikidata',
    'All stub articles',
    'Redirects to disambiguation pages',
    '2016',
    '2020s',
    '20th century',
    'Redirects from moves',
    'Start-Class biography articles',
    'Wikipedians who have received a Teahouse invitation through AfC',
    // Ruling 3 — the families that owned the top of the 30,000-node cut.
    'Short description is different from Wikidata',
    'Official website not in Wikidata',
    'Coordinates on Wikidata',
    'Official website different in Wikidata and Wikipedia',
    'Wikidata tracking categories',
    'Unprintworthy redirects',
    'Noindexed pages',
    'Pages using gadget WikiMiniAtlas',
    'Infobox road maps tracking category',
    'Single chart called without song',
    'Automatic category TOC generates no TOC',
    'Film articles needing an image',
    'Military history articles needing attention to referencing and citation',
    'Television episode articles with short description for single episodes',
    'Interlanguage link template existing link',
    'Taxonbars with multiple manual Wikidata items',
    'Set categories',
    'Source attribution',
    'Pages including recorded pronunciations',
    'Pages translated from German Wikipedia',
    'Wayback template wayback links',
    'Category series navigation using skip-gaps parameter',
    'Container categories',
    'Tracking categories',
    'Userboxes with insufficient color contrast',
    'Articles incorporating Cite DNB template',
    'Articles without KEGG source',
    'Navboxes using background colours',
    'Automatically assessed biography articles',
    'Pages within the scope of WikiProject Astronomical objects (WP Astronomy Banner)',
    'Album articles lacking alt text for covers',
    'Category-Class Years pages',
    'Unknown-importance List articles',
    'NA-importance Years pages',
    'Sports and games work group articles',
    'European military history task force articles',
    'Animation articles by work groups',
    'Harry Potter task force participants',
    'Articles of WikiProject Protected areas',
    'Biography articles of living people',
    'Year of birth unknown',
    'User talk pages with Uw-spam1 notices',
    'User en-N',
    'Male Wikipedians',
    'Paid contributors',
    'Users tagged as sockpuppets with no second parameter',
    'Suspected Wikipedia sockpuppets',
    'Local COIBot Reports',
    'Shared IP addresses from educational institutions',
    'Ended featured picture nominations',
    'Use American English from July 2025',
    'AfC submissions on living persons',
    'Accepted AfC submissions',
    'Taxonomy articles created by Polbot',
    'Non-free rationale as na',
    'Creative Commons Attribution-ShareAlike 3.0 files',
    'GFDL files',
    'Album covers',
    'Completed non-free use rationale logo transclusions',
  ];

  it('is the auditable list reported on /method', () => {
    expect(MAINTENANCE_PATTERNS.length).toBeGreaterThan(0);
    for (const source of MAINTENANCE_PATTERNS) {
      expect(() => new RegExp(source, 'i')).not.toThrow();
    }
  });

  it('has one real dump exemplar per pattern', () => {
    expect(EXCLUSIVE_EXEMPLARS).toHaveLength(MAINTENANCE_PATTERNS.length);
  });

  it('has no dead pattern: each one is exercised by a real dump title', () => {
    const orphans = MAINTENANCE_PATTERNS.filter(
      (source, i) => !new RegExp(source, 'i').test(EXCLUSIVE_EXEMPLARS[i]));
    expect(orphans).toEqual([]);
  });

  it('has no redundant pattern: each adds coverage an earlier pattern lacks', () => {
    // The reverse direction, and the one that catches a rule whose work is
    // already being done further up the list — including one that matches no
    // row at all and only looks alive because a neighbour matches the fixture.
    const redundant = [];
    MAINTENANCE_PATTERNS.forEach((source, i) => {
      const re = new RegExp(source, 'i');
      const claimedEarlier = MAINTENANCE_PATTERNS
        .slice(0, i)
        .some(p => new RegExp(p, 'i').test(EXCLUSIVE_EXEMPLARS[i]));
      if (!re.test(EXCLUSIVE_EXEMPLARS[i]) || claimedEarlier) redundant.push(source);
    });
    expect(redundant).toEqual([]);
  });

  it('drops what each exemplar names', () => {
    // The gate above proves the pattern is alive; this proves it does the
    // dropping, so an over-narrow pattern cannot pass on a borrowed fixture.
    for (const title of EXCLUSIVE_EXEMPLARS) {
      expect(isMaintenanceCategory(title)).toBe(true);
    }
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
