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

describe('MAINTENANCE_PATTERNS', () => {
  it('is the auditable list reported on /method', () => {
    expect(MAINTENANCE_PATTERNS.length).toBeGreaterThan(0);
    for (const source of MAINTENANCE_PATTERNS) {
      expect(() => new RegExp(source, 'i')).not.toThrow();
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