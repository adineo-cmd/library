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

  // Pass 1 gates, it neither rewrites nor deduplicates. It is a pure subset of
  // its input, so it cannot introduce a duplicate; deduping is Task 6's job and
  // is free there, where the name->id Map already collapses equal keys.
  it('passes duplicates through unchanged', () => {
    expect(applyMetaFilter(['Physics', 'Physics', 'CS1 x', 'Physics']))
      .toEqual(['Physics', 'Physics', 'Physics']);
  });
});
