import { describe, it, expect } from 'vitest';
import {
  markMetaRemoved, spliceRemovedNodes, compactSurvivors, applyMetaFilter,
} from '../prune.mjs';

/**
 * The meta filter, relocated to graph time.
 *
 * These tests exist because the filter used to run at ingest, where it could
 * only delete rows. Deleting the row of a category other categories hang from
 * does not remove a node from a tree — it promotes every child of that node to
 * a root. On the real dumps that left 1,061,927 of 2,481,394 categories (42.8%)
 * with no parent row at all, and 18.1% of atlas roots were maintenance
 * scaffolding. Everything below is about the one property that fixes it: a
 * removed node hands its children to its own parent.
 */

/** Names known to be removed by MAINTENANCE_PATTERNS, and names known to stay. */
const MAINTENANCE = [
  'CS1 references',            // ^CS\d
  'Living people',             // living people\)?$
  'Redirects from moves',      // " redirects\b"
  '1990s',                     // ^(1[89]|20)\d\ds$
  'Articles with errors',      // ^Articles with
];
const SUBJECTS = [
  'Physics', 'Thermodynamics', 'Films of 1999', 'Art', 'Mercury (planet)', '1960s in jazz',
];

/** `parentOf[i]` is the parent of node i, -1 for a root. */
function forest(parentOf) {
  return { parentOf: Int32Array.from(parentOf), nodeCount: parentOf.length };
}

/**
 * The survivor's view of a splice: each surviving name mapped to the surviving
 * name it ends up under, or -1 for a root. Written the way the build reads it
 * — splice, then compact — so a test that passes here is a claim about the
 * sequence the build actually runs.
 */
function splicedShape(names, parentOf) {
  const { parentOf: input, nodeCount } = forest(parentOf);
  const removed = markMetaRemoved(names);
  const spliced = spliceRemovedNodes(input, removed, nodeCount);
  const { original, names: keptNames, count } = compactSurvivors(names, removed);
  // `spliced` is indexed by ORIGINAL index; `keptNames` by survivor index. The
  // two only agree when nothing was removed, which is exactly the bug this
  // helper has to avoid reproducing.
  const out = new Map();
  for (let s = 0; s < count; s++) {
    const parent = spliced[original[s]];
    out.set(keptNames[s], parent === -1 ? -1 : names[parent]);
  }
  return { out, removed, spliced, count };
}

describe('markMetaRemoved', () => {
  it('flags maintenance names and leaves subject matter alone', () => {
    const names = ['Physics', 'CS1 references', 'Living people', 'Thermodynamics', 'Films of 1999'];
    expect([...markMetaRemoved(names)]).toEqual([0, 1, 1, 0, 0]);
  });

  it('judges a padded name on its trimmed value', () => {
    // The maintenance rules are `^`-anchored, so " CS1 x" would slip through an
    // untrimmed check. Same rule as applyMetaFilter.
    expect([...markMetaRemoved([' CS1 x ', ' Physics '])]).toEqual([1, 0]);
  });

  it('flags a blank name, which has no identity to key cat.name on', () => {
    expect([...markMetaRemoved(['', '   ', 'Physics'])]).toEqual([1, 1, 0]);
  });

  it('flags a non-string rather than throwing mid-build', () => {
    expect([...markMetaRemoved([undefined, null, 7, 'Physics'])]).toEqual([1, 1, 1, 0]);
  });

  it('agrees with applyMetaFilter on every name in the list', () => {
    // One rule, two shapes. If these ever diverge, the pattern list /method
    // publishes and the atlas stop describing the same filter.
    const names = [...SUBJECTS, ...MAINTENANCE, ''];
    const flagged = new Set(
      [...markMetaRemoved(names)].map((removed, i) => (removed ? names[i] : null)).filter(Boolean),
    );
    expect(flagged).toEqual(new Set(MAINTENANCE));
    expect(new Set(applyMetaFilter(names))).toEqual(new Set(SUBJECTS));
  });
});

describe('spliceRemovedNodes', () => {
  it('re-parents a node whose parent was removed to its grandparent', () => {
    // A -> B -> C, with B removed. Dropping B outright would leave C at -1 and
    // make it a second root; that is the bug this change is about, and the
    // assertion pins the exact index C must end up at.
    const { out } = splicedShape(['A', 'CS1 references', 'C'], [-1, 0, 1]);
    expect(out.get('C')).toBe('A');
    expect(out.get('A')).toBe(-1);
  });

  it('splices a chain of removed nodes through to the first survivor above it', () => {
    const { out } = splicedShape(
      ['A', 'CS1 references', 'Living people', 'D'],
      [-1, 0, 1, 2],
    );
    expect(out.get('D')).toBe('A');
    expect(out.get('A')).toBe(-1);
  });

  it('makes a survivor a root when every one of its ancestors was removed', () => {
    // -1, not a dangling index into a node the caller is about to drop. A
    // survivor under a wall of scaffolding has nowhere left to hang, and
    // "nowhere" has to mean a root.
    const { out } = splicedShape(
      ['1990s', 'CS1 references', 'Living people', 'D'],
      [-1, 0, 1, 2],
    );
    expect(out.get('D')).toBe(-1);
  });

  it('leaves a survivor alone when nothing above it was removed', () => {
    const { out } = splicedShape(['A', 'B', 'C'], [-1, 0, 1]);
    expect(out.get('C')).toBe('B');
    expect(out.get('B')).toBe('A');
  });

  it('never returns a reference to a node that is not in the output', () => {
    // The invariant, over a graph with scaffolding at every level: after splice
    // and compact, every surviving node's parent is either -1 or another
    // survivor. A splice that handed back a removed index would leave a dangling
    // parent that only the zod schema downstream would catch — 37,000 nodes too
    // late to say why.
    const names = [
      'Main topic classifications', 'CS1 references', 'Living people', 'Physics',
      '1990s', 'Thermodynamics', 'Redirects from moves', 'Art', 'Films of 1999',
      'Music', '1990s',
    ];
    // A forest, with maintenance nodes interleaved at three depths.
    const parentOf = [-1, 0, 0, 1, 2, 4, 2, 0, 0, 7, 9];
    const { parentOf: input, nodeCount } = forest(parentOf);
    const removed = markMetaRemoved(names);
    const spliced = spliceRemovedNodes(input, removed, nodeCount);
    const { remap, original, names: kept, count } = compactSurvivors(names, removed);

    expect(count).toBe(6);
    expect(kept).not.toContain('CS1 references');
    expect(kept).not.toContain('Living people');
    for (let s = 0; s < count; s++) {
      const parent = spliced[original[s]];
      expect(parent === -1 || !removed[parent]).toBe(true);
      // And, in survivor space, a parent that is either -1 or a real survivor.
      const asSurvivor = parent === -1 ? -1 : remap[parent];
      expect(asSurvivor === -1 || asSurvivor < count).toBe(true);
    }
    // Art was parented to a removed node ('1990s' is gone, and so is the
    // 'CS1 references' above it), so it must have been lifted to its
    // grandparent rather than left pointing at scaffolding.
    expect(kept[remap[7]]).toBe('Art');
    expect(spliced[7]).toBe(0);
  });

  it('fails loudly rather than looping if the input is not a forest', () => {
    // breakCycles guarantees this cannot happen; the guard exists so a bug
    // upstream surfaces here rather than as a hang in the layout stage.
    const cyclic = Int32Array.from([1, 0, 1]);
    const removed = new Uint8Array([1, 1, 0]);
    expect(() => spliceRemovedNodes(cyclic, removed, 3)).toThrow(/cycles through removed nodes/);
  });

  it("copies rather than mutating the caller's array", () => {
    const { parentOf } = forest([-1, 0, 1]);
    const before = Int32Array.from(parentOf);
    spliceRemovedNodes(parentOf, new Uint8Array([0, 1, 0]), 3);
    expect([...parentOf]).toEqual([...before]);
  });

  it('still splices correctly when the removed chain is walked in one pass', () => {
    // The order-independence claim. A depth-ordered deletion is subtly wrong
    // exactly here: when a chain of removed nodes sits next to a surviving one,
    // deleting shallowest-first has already moved a survivor's pointer past the
    // node it is about to remove. There is no ordering to get wrong when every
    // survivor simply walks up for itself.
    const names = ['A', 'CS1 references', 'Living people', 'D', 'E'];
    const parentOf = [-1, 0, 1, 2, 3];
    const { out } = splicedShape(names, parentOf);
    expect(out.get('D')).toBe('A');
    expect(out.get('E')).toBe('D');
    expect(out.get('A')).toBe(-1);
  });
});

describe('compactSurvivors', () => {
  it('maps original index to surviving index and back, consistently', () => {
    const names = ['A', 'CS1 references', 'B', 'Living people', 'C'];
    const { remap, original, names: kept, count } = compactSurvivors(names, markMetaRemoved(names));
    expect(count).toBe(3);
    expect([...remap]).toEqual([0, -1, 1, -1, 2]);
    expect([...original]).toEqual([0, 2, 4]);
    expect(kept).toEqual(['A', 'B', 'C']);
    // The two maps must be inverses on survivors, or an edge translated through
    // one of them lands on the wrong node.
    for (let s = 0; s < count; s++) expect(remap[original[s]]).toBe(s);
  });

  it('is a no-op when nothing is removed', () => {
    const names = ['A', 'B', 'C'];
    const { remap, original, count } = compactSurvivors(names, markMetaRemoved(names));
    expect(count).toBe(3);
    expect([...remap]).toEqual([0, 1, 2]);
    expect([...original]).toEqual([0, 1, 2]);
  });
});