import { describe, it, expect } from 'vitest';
import { applyMetaFilter } from '../prune.mjs';

describe('applyMetaFilter', () => {
  it('removes maintenance categories', () => {
    expect(applyMetaFilter(['Physics', 'CS1 references', 'WikiProject Foo', 'Thermodynamics']))
      .toEqual(['Physics', 'Thermodynamics']);
  });
  it('removes bare years and year spans but keeps years inside names', () => {
    expect(applyMetaFilter(['1900', '1990s', 'Films of 1999', 'Medicine']))
      .toEqual(['Films of 1999', 'Medicine']);
  });
  it('preserves input order', () => {
    expect(applyMetaFilter(['Zebra', 'CS1 x', 'Apple'])).toEqual(['Zebra', 'Apple']);
  });
  it('drops empties and whitespace-only names', () => {
    expect(applyMetaFilter(['', '   ', 'Physics'])).toEqual(['Physics']);
  });
  it('returns a new array and does not mutate the input', () => {
    const input = ['Physics', 'CS1 x'];
    const out = applyMetaFilter(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(['Physics', 'CS1 x']);
  });

  // Padded names must be judged on the trimmed value: the maintenance rules are
  // `^`-anchored, so " CS1 x" would slip through an untrimmed check.
  it('judges a padded name on its trimmed value', () => {
    expect(applyMetaFilter([' CS1 x ', ' Physics '])).toEqual([' Physics ']);
  });

  // Ruling 2: the three families below carried 2,615 of the 30,000 nodes in the
  // simulated cut and 33% of its pages, and pass 1 kept every one of them.
  it('drops the redirect, assessment and Wikipedians families', () => {
    expect(applyMetaFilter([
      'Physics',
      'Redirects from moves',
      'Start-Class biography articles',
      'Wikipedians who have received a Teahouse invitation',
      'Films of 1999',
    ])).toEqual(['Physics', 'Films of 1999']);
  });

  // Pass 1 gates, it neither rewrites nor deduplicates. It is a pure subset of
  // its input, so it cannot introduce a duplicate; deduping is Task 6's job and
  // is free there, where the name->id Map already collapses equal keys.
  it('passes duplicates through unchanged', () => {
    expect(applyMetaFilter(['Physics', 'Physics', 'CS1 x', 'Physics']))
      .toEqual(['Physics', 'Physics', 'Physics']);
  });
});
