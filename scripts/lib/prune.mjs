import { isMaintenanceCategory } from './categories.mjs';

/**
 * Pass 1 — the meta filter. Drops Wikipedia's maintenance scaffolding
 * (stub/citation-tag/WikiProject/namespace clutter) and names that are a bare
 * period rather than a subject, so `CS1 references` and `1990s` go while
 * `Films of 1999` stays.
 *
 * Needs no graph structure, so it runs first, on the raw name list, before any
 * parent/child relationship exists.
 *
 * `names` must already be normalised by `normalizeCategoryName`; this only
 * gates and never rewrites. A padded name is judged on its trimmed value —
 * the maintenance rules are `^`-anchored, so an untrimmed check would let
 * `" CS1 x"` through — but the original element is what gets returned.
 *
 * A pure subset of its input: order preserved, no dedup, no mutation, one
 * linear scan. Safe over the full ~2.6M-row category table.
 */
export function applyMetaFilter(names) {
  return names.filter(name => {
    const trimmed = name.trim();
    return trimmed.length > 0 && !isMaintenanceCategory(trimmed);
  });
}
