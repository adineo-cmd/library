import { describe, it, expect } from 'vitest';
import {
  capDepth, rankAndCut, assertAcyclic,
  selectPrimaryParents, breakCycles, assignDepth, subtreePages,
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
  // Ranking is on SUBTREE totals, so a trunk outranks its own descendants:
  // node 0 sums 10+90+50+20 = 170 against node 1's 90, so the top 2 are node 0
  // and node 1. Node 0 is kept outright and nothing needs restoring.
  it('keeps the top N by subtree article count', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 0, 0]), Int32Array.from([0, 1, 1, 1]), [10, 90, 50, 20], 4, 2,
    );
    expect(Array.from(kept)).toEqual([1, 1, 0, 0]);
    expect(restoredCount).toBe(0);
  });

  // The direct-count ranking this replaced kept only index 1 (90) and index 2
  // (50) and needed node 0 restored as their shared parent. On subtree totals
  // node 0 already ranks first, so the trunk no longer depends on restoration
  // to exist at all.
  it('ranks a trunk above its descendants on subtree count', () => {
    const { kept } = rankAndCut(
      Int32Array.from([-1, 0, 0, 0]), Int32Array.from([0, 1, 1, 1]), [0, 1, 1, 1], 4, 1,
    );
    expect(Array.from(kept)).toEqual([1, 0, 0, 0]);
  });

  // Subtree ranking makes a parent's total >= its child's, so a parent almost
  // always wins its own slot and restoration has nothing to do. It still
  // matters on an exact tie, where the lower index wins the cut and an
  // ancestor can be excluded: here node 1 owns no pages of its own and has a
  // single child, so both total 50 and node 0 takes the only slot. Node 1 is
  // the parent of a kept node, so it comes back and the kept node stays
  // reachable from a root.
  it('restores an ancestor that lost a subtree tie', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([1, -1]), Int32Array.from([1, 0]), [50, 0], 2, 1,
    );
    expect(Array.from(kept)).toEqual([1, 1]);
    expect(restoredCount).toBe(1);
  });

  // The load-bearing case from the real dump: every broad field has a tiny
  // direct article count (Philosophy 25, Physics 42) because content lives in
  // subcategories, and the cut sits at ~304 pages. Measured on the real dump,
  // direct counts cleared it for 1 of 30 fields and subtree totals for 30 of 30.
  // This is the shape that failed: a trunk with almost no pages of its own.
  it('keeps a trunk whose pages all live in its descendants', () => {
    // Node 0 holds 5 pages directly but its subtree holds 5+10+9999.
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 1]), Int32Array.from([0, 1, 2]), [5, 10, 9999], 3, 1,
    );
    expect(Array.from(kept)).toEqual([1, 0, 0]);
    expect(restoredCount).toBe(0);
  });

  // Restoration walks ANCESTORS only. A kept node's siblings, cousins and
  // descendants are not pulled in just because they share a neighbourhood.
  // Node 0 is kept; its parent node 1 comes back, while node 2 (sibling) and
  // node 3 (child) stay cut even though node 3 is on the path to a root.
  it('restores only the ancestor chain, not siblings or descendants', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([1, -1, 1, 0]), Int32Array.from([1, 0, 1, 2]), [50, 0, 0, 5], 4, 1,
    );
    expect(Array.from(kept)).toEqual([1, 1, 0, 0]);
    expect(restoredCount).toBe(1);
  });

  // The sort is total: equal totals fall back to the lower index, so the cut
  // is deterministic and independent of input order. Nodes 1 and 2 both
  // total 50; node 0 totals 100 and takes the only slot at target 1.
  it('breaks a subtree articleCount tie on the lower index', () => {
    const { kept } = rankAndCut(
      Int32Array.from([-1, 0, 0]), Int32Array.from([0, 1, 1]), [0, 50, 50], 3, 1,
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

describe('subtreePages', () => {
  it('sums each node with its descendants', () => {
    expect(Array.from(subtreePages(
      Int32Array.from([-1, 0, 1]), [5, 10, 20], 3,
    ))).toEqual([35, 30, 20]);
  });

  // A trunk is mostly its descendants' pages, which is the whole point: the
  // real fields hold 17-181 pages directly and hundreds of thousands below.
  it('attributes a trunk to the content beneath it', () => {
    const total = subtreePages(Int32Array.from([-1, 0]), [25, 373198], 2);
    expect(total[0]).toBe(373223);
    expect(total[1]).toBe(373198);
  });

  // Several parent edges may reach the same node (Wikipedia categories are
  // many-parented; pass 2 picks one primary, but this must not assume it).
  // The node contributes once, and the sum is never larger than the input.
  it('counts a multiply-reached node once', () => {
    const total = subtreePages(Int32Array.from([-1, 0, 0]), [0, 0, 7], 3);
    expect(total[0]).toBe(7);
  });

  it('handles a forest with several roots', () => {
    expect(Array.from(subtreePages(
      Int32Array.from([-1, -1, 1]), [1, 2, 3], 3,
    ))).toEqual([1, 5, 3]);
  });

  it('treats an isolated root as its own subtree', () => {
    expect(Array.from(subtreePages(Int32Array.from([-1]), [42], 1))).toEqual([42]);
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

    // Subtree totals after the depth cap: node 6 (900) was re-parented to
    // node 4, so the totals roll up 0 (2082) > 1 (2077) > 2 (2060) > 4 (910)
    // > 7 (1100 -> actually 7's own 800 + node 8's 300). Top 3 are the three
    // trunk nodes, and each one's whole chain is already in the kept set, so
    // restoration has nothing left to do.
    const { kept, restoredCount } = rankAndCut(capped, depth, articleCount, 9, 3);
    expect(Array.from(kept)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(restoredCount).toBe(0);

    // On direct counts this same fixture kept 6, 7 and 8 (900/800/300) and
    // needed five ancestors restored to reach a root. That is the failure mode
    // subtree ranking removes: the trunk is kept on its own merit, so the atlas
    // is navigable from the top instead of hanging off whichever leaf happened
    // to hold the most articles.

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
