import { describe, it, expect } from 'vitest';
import {
  capDepth, rankAndCut, assertAcyclic,
  selectPrimaryParents, breakCycles, assignDepth,
} from '../prune.mjs';

describe('capDepth', () => {
  it('re-parents a depth-6 node to its depth-5 ancestor', () => {
    const { parentOf: capped } = capDepth(Int32Array.from([-1, 0, 1, 2, 3, 4, 5]), 7, 5);
    expect(capped[5]).toBe(4);
    expect(capped[6]).toBe(4);
  });
  it('counts the removed node', () => {
    expect(capDepth(Int32Array.from([-1, 0, 1, 2, 3, 4, 5]), 7, 5).removedCount).toBe(1);
  });
  it('leaves a shallow tree untouched', () => {
    const { parentOf: capped, removedCount } = capDepth(Int32Array.from([-1, 0, 0]), 3, 5);
    expect(Array.from(capped)).toEqual([-1, 0, 0]);
    expect(removedCount).toBe(0);
  });

  // The cap is a bound on depth, so every node deeper than maxDepth must land
  // at exactly maxDepth — the anchor is the ancestor one level above the cap.
  // A depth-8 chain collapses onto the depth-4 ancestor, three nodes re-parented.
  it('collapses a depth-8 chain so every node lands at exactly maxDepth', () => {
    const { parentOf: capped, removedCount } = capDepth(
      Int32Array.from([-1, 0, 1, 2, 3, 4, 5, 6, 7]), 9, 5,
    );
    expect(Array.from(capped)).toEqual([-1, 0, 1, 2, 3, 4, 4, 4, 4]);
    expect(removedCount).toBe(3);
    const depth = assignDepth(capped, 9);
    expect(Array.from(depth)).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 5]);
    expect(() => assertAcyclic(capped, 9)).not.toThrow();
  });

  // Re-parenting to a strict ancestor can neither create a cycle nor a
  // self-parent; assertAcyclic is the check that would catch either.
  it('keeps the result acyclic and free of self-parents', () => {
    const parentOf = Int32Array.from([-1, 0, 1, 2, 3, 4, 5, 6, 7, 4, 4]);
    const { parentOf: capped } = capDepth(parentOf, 11, 5);
    expect(() => assertAcyclic(capped, 11)).not.toThrow();
    for (let i = 0; i < 11; i++) expect(capped[i]).not.toBe(i);
  });

  it('does not mutate the input array', () => {
    const input = Int32Array.from([-1, 0, 1, 2, 3, 4, 5]);
    capDepth(input, 7, 5);
    expect(Array.from(input)).toEqual([-1, 0, 1, 2, 3, 4, 5]);
  });
});

describe('rankAndCut', () => {
  it('keeps the top N by articleCount', () => {
    // counts 10, 90, 50, 20 -> keep 2: index 1 (90) and index 2 (50).
    // Node 0 is then restored as the shared parent of both kept nodes, so the
    // final kept set is {0, 1, 2}. (The plan's draft of this test expected
    // [1,0,1,0], which cuts the highest-count node and keeps the lowest — it
    // contradicts the test's own comment, the restore test below, and spec
    // 5.6. [1,1,1,0] is the only reading consistent with all three.)
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 0, 0]), Int32Array.from([0, 1, 1, 1]), [10, 90, 50, 20], 4, 2,
    );
    expect(Array.from(kept)).toEqual([1, 1, 1, 0]);
    expect(restoredCount).toBe(1);
  });
  it('restores ancestors needed to keep a kept node reachable', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 1, 2]), Int32Array.from([0, 1, 2, 3]), [1, 2, 3, 9999], 4, 1,
    );
    expect(Array.from(kept)).toEqual([1, 1, 1, 1]);
    expect(restoredCount).toBe(3);
  });

  // The load-bearing case from the real dump: every broad field has a tiny
  // direct article count (Physics 42, Mathematics 33) because content lives in
  // subcategories, and the 30k cut sits at ~304 pages. A trunk survives only
  // because a high-count descendant pulls it back — here node 0 is reachable
  // from the kept set only through node 2, and has no other kept descendant.
  it('restores a low-count trunk reachable only through a high-count descendant', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 1]), Int32Array.from([0, 1, 2]), [5, 10, 9999], 3, 1,
    );
    expect(Array.from(kept)).toEqual([1, 1, 1]);
    expect(kept[0]).toBe(1);
    expect(restoredCount).toBe(2);
  });

  // Restoration walks ANCESTORS only. A kept node's siblings, cousins and
  // descendants are not pulled in just because they share a neighbourhood.
  it('restores only the ancestor chain, not siblings or descendants', () => {
    // 0 -> 1, 0 -> 2, 2 -> 3. Keep node 2 only: node 0 comes back as its
    // parent; node 1 (sibling) and node 3 (child) stay cut.
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 0, 2]), Int32Array.from([0, 1, 1, 2]), [1, 2, 9999, 5], 4, 1,
    );
    expect(Array.from(kept)).toEqual([1, 0, 1, 0]);
    expect(restoredCount).toBe(1);
  });

  // The sort is total: equal counts fall back to the lower index, so the cut
  // is deterministic and independent of input order.
  it('breaks an articleCount tie on the lower index', () => {
    const { kept } = rankAndCut(
      Int32Array.from([-1, 0, 0]), Int32Array.from([0, 1, 1]), [50, 50, 10], 3, 1,
    );
    expect(Array.from(kept)).toEqual([1, 0, 0]);
  });

  it('restores nothing when every kept node is a root', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, -1, -1]), Int32Array.from([0, 0, 0]), [1, 2, 3], 3, 2,
    );
    expect(Array.from(kept)).toEqual([0, 1, 1]);
    expect(restoredCount).toBe(0);
  });
});

describe('assertAcyclic', () => {
  it('passes on an acyclic forest', () => {
    expect(() => assertAcyclic(Int32Array.from([-1, 0, 1]), 3)).not.toThrow();
  });
  it('throws on a cycle', () => {
    expect(() => assertAcyclic(Int32Array.from([1, 0]), 2)).toThrow(/cycle/i);
  });

  // A node hanging off a cycle reaches no root either, so it must be reported
  // too — otherwise a cycle with a tail would pass on a technicality.
  it('throws when a node hangs off a cycle', () => {
    expect(() => assertAcyclic(Int32Array.from([-1, 2, 1, 2]), 4)).toThrow(/cycle/i);
  });

  it('returns the depths when the graph is a forest', () => {
    expect(Array.from(assertAcyclic(Int32Array.from([-1, 0, 1, 0]), 4))).toEqual([0, 1, 2, 1]);
  });
});

// The pipeline the atlas is built on: pass 2 (primary parents + cycle
// breaking) -> pass 3 (depth cap) -> passes 4-5 (rank, cut, restore). The
// invariants that matter on the real graph, where max depth was 41 and 83% of
// nodes sat deeper than 5: the capped forest is acyclic with every depth
// <= 5, and the low-count trunk survives the cut only via restoration.
describe('prune pipeline end to end', () => {
  // A Wikipedia-shaped mini-graph: a trunk chain down to a deep high-count
  // leaf, plus a second high-count branch. Counts mirror the real ones —
  // the trunk categories are tiny, the leaves are large.
  //
  //   0 Contents (5)
  //   1 Physical sciences (17)
  //   2 Physics (42)
  //   3 Mechanics (8)
  //   4 Classical mechanics (6)
  //   5 Newton's laws (4)
  //   6 Newton's first law (900)   <- depth 6, capped
  //   7 Quantum mechanics (800)
  //   8 Quantum field theory (300)
  const parentsByChild = [[], [0], [1], [2], [3], [4], [5], [2], [7]];
  const articleCount = [5, 17, 42, 8, 6, 4, 900, 800, 300];

  it('caps depth, keeps the trunk, and leaves an acyclic forest', () => {
    const { primary, demoted } = selectPrimaryParents(parentsByChild, 9);
    const fixed = breakCycles(primary, demoted, 9);
    const { parentOf: capped, removedCount } = capDepth(fixed, 9, 5);
    const depth = assertAcyclic(capped, 9);

    // The depth-6 leaf was re-parented to the depth-4 ancestor; nothing deeper
    // than 5 remains, and the cap removed exactly one deep edge.
    expect(removedCount).toBe(1);
    expect(capped[6]).toBe(4);
    expect(Array.from(depth).every(d => d >= 0 && d <= 5)).toBe(true);

    const { kept, restoredCount } = rankAndCut(capped, depth, articleCount, 9, 3);

    // Top 3 by count: 6 (900), 7 (800), 8 (300). Restoration pulls the whole
    // chain 0-4 back for node 6; node 5 (count 4) stays cut.
    expect(restoredCount).toBe(5);
    expect(Array.from(kept)).toEqual([1, 1, 1, 1, 1, 0, 1, 1, 1]);

    // The trunk — node 0, count 5, far below the cut — survives only because
    // a high-count descendant needed it for reachability.
    expect(kept[0]).toBe(1);

    // The kept subset is a sub-forest of an acyclic forest: every kept node
    // with a kept parent still reaches a root, so no cycle can appear.
    const keptParentOf = Int32Array.from(capped);
    for (let i = 0; i < 9; i++) {
      if (!kept[i]) keptParentOf[i] = -1;
      else if (capped[i] !== -1 && !kept[capped[i]]) keptParentOf[i] = -1;
    }
    expect(() => assertAcyclic(keptParentOf, 9)).not.toThrow();
  });
});
