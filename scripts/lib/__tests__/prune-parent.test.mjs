import { describe, it, expect } from 'vitest';
import {
  computeSubtreeSizes, selectPrimaryParents, breakCycles, assignDepth,
} from '../prune.mjs';

const MAX_INT32 = 2147483647;

/** Deterministic PRNG — a test that depends on Math.random is not a test. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeSubtreeSizes', () => {
  it('counts a node and everything beneath it', () => {
    // 0 -> 1 -> 2, plus 0 -> 3
    const sizes = computeSubtreeSizes([[1, 3], [2], [], []], 4);
    expect(Array.from(sizes)).toEqual([4, 2, 1, 1]);
  });

  // The graph is a DAG, so sizes are a path count, not a distinct-descendant
  // count: node 3 is reachable from 0 by two routes and is counted twice, for 5
  // where the distinct count is 4. Pinned deliberately — pass 2 ranks parents
  // by this measure, so its exact definition is part of the contract.
  it('counts both routes into a converging descendant', () => {
    //   1
    //  / \
    // 0   2
    //  \ /
    //   3
    const sizes = computeSubtreeSizes([[1, 2], [3], [3], []], 4);
    expect(Array.from(sizes)).toEqual([5, 2, 2, 1]);
  });

  // Wikipedia's graph has hubs with ~219k subcategories, so the traversal must
  // not recurse and the pending stack must not be capped at nodeCount: a node
  // that has not been expanded yet can still be pushed twice.
  it('walks a 100k-deep chain iteratively, with no recursion', () => {
    const n = 100000;
    const children = new Array(n);
    for (let i = 0; i < n - 1; i++) children[i] = [i + 1];
    children[n - 1] = [];
    const sizes = computeSubtreeSizes(children, n);
    expect(sizes[0]).toBe(n);
    expect(sizes[n - 1]).toBe(1);
  });

  // Int32Array wraps silently on overflow. A DAG's path count is unbounded —
  // node i -> i+1 and i+2 is Fibonacci — and the sizes are compared with a
  // subtraction, so a wrapped negative would invert the whole ordering.
  it('saturates at the Int32 ceiling instead of wrapping negative', () => {
    const n = 60;
    const children = new Array(n);
    for (let i = 0; i < n - 2; i++) children[i] = [i + 1, i + 2];
    children[n - 2] = [n - 1];
    children[n - 1] = [];
    const sizes = computeSubtreeSizes(children, n);
    expect(sizes[n - 1]).toBe(1);
    expect(sizes[0]).toBe(MAX_INT32);
    expect(Array.from(sizes).every(s => s >= 1)).toBe(true);
  });

  it('counts a node with no children as one', () => {
    expect(Array.from(computeSubtreeSizes([[], []], 2))).toEqual([1, 1]);
  });
});

describe('selectPrimaryParents', () => {
  it('picks the parent with the largest subtree', () => {
    //     2      3
    //    / \     |
    //   4   5    6
    //  / \   \
    // 7   8   9
    const parentsByChild = [[], [], [1], [1], [2], [2], [4], [4], [5]];
    const { primary } = selectPrimaryParents(parentsByChild, 9);
    expect(primary[2]).toBe(1);
    expect(primary[3]).toBe(1);
  });

  // The rule that decides real content: a broad field beats an alphabetically
  // earlier narrow one. Node 0 is a leaf; node 1 carries four descendants.
  it('prefers a bigger subtree over a lower index', () => {
    //      1
    //     /|\
    //    2 3 4
    //       |
    //       5
    const parentsByChild = [[], [], [1], [1], [1], [3]];
    const { primary } = selectPrimaryParents(parentsByChild, 6);
    expect(primary[4]).toBe(1);
    expect(primary[5]).toBe(3);

    const { primary: p2 } = selectPrimaryParents([[], [], [0, 1], [1]], 4);
    expect(p2[2]).toBe(1);
  });

  // Size is the first sort key and index only ever breaks ties — a lower-index
  // parent cannot win while carrying a *smaller* subtree, so the only
  // observable direction is the higher-index parent winning on size. Both a
  // two-way and a three-way contest are pinned here.
  it('ranks competing parents by subtree size', () => {
    // 0 -> 2 and 1 -> 2 and 3 -> 1. sizes 2,3,1,1: node 1 wins on size,
    // a pure (a - b) comparator would have taken node 0.
    const twoWay = selectPrimaryParents([[], [], [0, 1], [1]], 4);
    expect(Array.from(twoWay.sizes)).toEqual([2, 3, 1, 1]);
    expect(twoWay.primary[2]).toBe(1);
    expect(twoWay.demoted).toEqual([{ child: 2, parent: 0 }]);

    // Node 2 has three parents. sizes 3,7,2,3,1,1: node 1 wins outright, and
    // the losing two are demoted in size order.
    const threeWay = selectPrimaryParents([[], [], [0, 1, 3], [1], [1], [2]], 6);
    expect(Array.from(threeWay.sizes)).toEqual([3, 7, 2, 3, 1, 1]);
    expect(threeWay.primary[2]).toBe(1);
    expect(threeWay.demoted).toEqual([{ child: 2, parent: 0 }, { child: 2, parent: 3 }]);
  });

  it('demotes the losing candidates', () => {
    const { primary, demoted } = selectPrimaryParents([[], [], [1, 0], [], []], 4);
    expect(primary[2]).toBe(0);
    expect(demoted).toEqual([{ child: 2, parent: 1 }]);
  });

  // Determinism is order-independence, not just "a pure function called twice":
  // listing each node's parents in a different order must not move a single
  // edge, because the sort is a total order and the adjacency is built by
  // ascending child index.
  it('is deterministic across runs', () => {
    const base = [[], [2, 3], [0], [], [1, 2, 3], [1]];
    const shuffled = [[], [3, 2], [0], [], [2, 3, 1], [1]];
    const a = selectPrimaryParents(base, 6);
    const b = selectPrimaryParents(shuffled, 6);
    expect(Array.from(b.primary)).toEqual(Array.from(a.primary));
    expect(Array.from(b.sizes)).toEqual(Array.from(a.sizes));
    expect(b.demoted).toEqual(a.demoted);
    expect(a.demoted.length).toBeGreaterThan(0);
  });

  it('leaves a node with no parents as a root', () => {
    const { primary } = selectPrimaryParents([[], [], [1], []], 4);
    expect(primary[0]).toBe(-1);
    expect(primary[1]).toBe(-1);
  });

  // Depth is undefined until primary parents exist, so "shallower parent" cannot
  // be a tie-break here. The remaining total order is (subtree desc, index
  // asc) — and stable ids are alphabetical, so that is the spec's "name
  // ascending" tie-break with the index standing in for the name. This graph
  // is a genuine tie: both parents have subtree 2, node 2 is a leaf.
  it('breaks a subtree tie on the lower index', () => {
    const { primary, demoted, sizes } = selectPrimaryParents([[], [], [0, 1]], 3);
    expect(Array.from(sizes)).toEqual([2, 2, 1]);
    expect(primary[2]).toBe(0);
    expect(demoted).toEqual([{ child: 2, parent: 1 }]);
  });

  // The `parent` table has no unique constraint, so the same (child, parent)
  // row can arrive twice. Without dedup the repeated winner is demoted against
  // itself and the node ends up cross-linking to its own parent.
  it('counts a repeated parent edge once', () => {
    expect(selectPrimaryParents([[], [], [1, 1]], 4).demoted).toEqual([]);
    expect(selectPrimaryParents([[], [], [1, 0, 0]], 4).demoted)
      .toEqual([{ child: 2, parent: 1 }]);
  });

  it('never emits a cross-link from a node to itself', () => {
    // Node 3 lists itself as a subcategory. The self-edge is also its smaller
    // parent (sizes 2 vs 3), so it loses the ranking and would be demoted —
    // breakCycles never sees that copy, so it has to be dropped here.
    const { primary, demoted } = selectPrimaryParents([[], [], [], [2, 3], []], 5);
    expect(primary[3]).toBe(2);
    expect(demoted).toEqual([]);

    // When the self-edge wins the ranking it becomes a self-loop in the primary
    // forest, and breakCycles detaches that into a root — again with no self
    // cross-link.
    const won = selectPrimaryParents([[], [3], [], [3], [3], [2]], 6);
    expect(won.primary[3]).toBe(3);
    const demoted2 = [];
    const fixed = breakCycles(won.primary, demoted2, 6);
    expect(fixed[3]).toBe(-1);
    expect(demoted2).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [[], [], [1, 0], [], []];
    const copy = JSON.parse(JSON.stringify(input));
    selectPrimaryParents(input, 5);
    expect(input).toEqual(copy);
  });

  // A malformed parent index would otherwise be written out of bounds on a
  // typed array, which is silently discarded and yields a quietly wrong forest.
  it('rejects a parent index outside the node range', () => {
    expect(() => selectPrimaryParents([[], [7]], 2)).toThrow(/parent index/);
    expect(() => selectPrimaryParents([[], [-1]], 2)).toThrow(/parent index/);
  });
});

describe('breakCycles', () => {
  it('breaks a two-node cycle', () => {
    const fixed = breakCycles(Int32Array.from([1, 0, -1, 1]), [], 4);
    expect(fixed[0]).toBe(-1);
    expect(fixed[1]).toBe(0);
  });

  // Spec 5.3: a cycle is broken by demoting exactly one of its edges, not by
  // rewiring the component. 0 -> 1 -> 2 -> 0 loses only 0 -> 1, which leaves 0
  // the root with 2 and 1 already beneath it; nothing is re-parented.
  it('detaches one edge of a three-node cycle and keeps the rest', () => {
    const demoted = [];
    const fixed = breakCycles(Int32Array.from([1, 2, 0, -1]), demoted, 4);
    expect(fixed[0]).toBe(-1);
    expect(fixed[1]).toBe(2);
    expect(fixed[2]).toBe(0);
    expect(demoted).toEqual([{ child: 0, parent: 1 }]);
    expect(Array.from(assignDepth(fixed, 4))).toEqual([0, 2, 1, 0]);
  });

  // The victim is the lowest index. Not derived from size: `sizes` is a path
  // count on the raw graph, and a cycle member has no well-defined subtree, so
  // a size rule would be a heuristic. Lowest index is total, order-independent
  // and costs one comparison. Only the component's root changes either way.
  it('detaches the lowest-index member of the cycle', () => {
    // 0 -> 1 -> 2 -> 0, plus 3 -> 2 and 4 -> 3. Cutting 0 leaves 3 and 4
    // hanging off 2 and still attached to the new root.
    const demoted = [];
    const fixed = breakCycles(Int32Array.from([1, 2, 0, 2, 3]), demoted, 5);
    expect(fixed[0]).toBe(-1);
    expect(Array.from(fixed)).toEqual([-1, 2, 0, 2, 3]);
    expect(demoted).toEqual([{ child: 0, parent: 1 }]);
    expect(Array.from(assignDepth(fixed, 5))).toEqual([0, 2, 1, 2, 3]);
  });

  // The cycle is the tail of the path, not the path: cutting an edge that
  // merely hangs below the cycle would leave the cycle in place.
  it('cuts inside the cycle, not below it', () => {
    // 1 -> 2 -> 0 -> 1, with 3 hanging off 1. Walked from 0 the path is
    // 0, 1, 2, 1 and the cycle is 1, 2, 0 — victim 0, not 3.
    const fixed = breakCycles(Int32Array.from([1, 2, 0, 1]), [], 4);
    expect(fixed[0]).toBe(-1);
    expect(Array.from(assignDepth(fixed, 4))).toEqual([0, 2, 1, 3]);
  });

  // Every other cycle test here is entered from a root or from below at the
  // lowest member, so it cannot tell the min-scan from "take the member the
  // walk happened to arrive at". Here the walk 3 -> 12 -> 5 -> 12 arrives at
  // 12, which is the *highest*-indexed member: first-found would detach 12 and
  // leave 5 as its parent, lowest-index detaches 5.
  it('detaches the lowest-index member when the walk enters at a higher one', () => {
    const demoted = [];
    const fixed = breakCycles(Int32Array.from([-1, -1, -1, 12, -1, 12, -1, -1, -1, -1, -1, -1, 5]), demoted, 13);
    expect(fixed[5]).toBe(-1);
    expect(fixed[12]).toBe(5);
    expect(demoted).toEqual([{ child: 5, parent: 12 }]);
    expect(Array.from(assignDepth(fixed, 13)))
      .toEqual([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  // `Math.min(...cycle)` throws RangeError once a cycle has ~10^5 members, and
  // a cyclic component is exactly the kind of thing that turns up by accident.
  it('breaks a 100k-member cycle', () => {
    const n = 100000;
    const primary = new Int32Array(n);
    for (let i = 0; i < n; i++) primary[i] = (i + 1) % n;
    const demoted = [];
    const fixed = breakCycles(primary, demoted, n);
    expect(fixed[0]).toBe(-1);
    expect(demoted).toEqual([{ child: 0, parent: 1 }]);
    const depths = assignDepth(fixed, n);
    expect(depths[0]).toBe(0);
    expect(depths[n - 1]).toBe(1);
    expect(depths[1]).toBe(n - 1);
  });

  it('leaves an acyclic forest untouched', () => {
    const primary = Int32Array.from([-1, 0, 1, 0]);
    expect(Array.from(breakCycles(primary, [], 4))).toEqual(Array.from(primary));
  });

  // A category that lists itself as a subcategory is a one-member cycle.
  it('detaches a self-edge without cross-linking a node to itself', () => {
    const demoted = [];
    const fixed = breakCycles(Int32Array.from([0, 1, -1]), demoted, 3);
    expect(fixed[0]).toBe(-1);
    expect(demoted).toEqual([]);
  });

  it('does not mutate the primary array it is given', () => {
    const primary = Int32Array.from([1, 0, -1]);
    breakCycles(primary, [], 3);
    expect(Array.from(primary)).toEqual([1, 0, -1]);
  });
});

describe('assignDepth', () => {
  it('assigns depth from the roots', () => {
    expect(Array.from(assignDepth(Int32Array.from([-1, 0, 1, 0]), 4))).toEqual([0, 1, 2, 1]);
  });
  it('marks nodes unreachable from any root as -1', () => {
    const depths = Array.from(assignDepth(Int32Array.from([-1, 2, 1, 1]), 4));
    expect(depths[0]).toBe(0);
    expect(depths[3]).toBe(-1);
  });
  it('leaves a whole cyclic component at -1, not just the cycle', () => {
    // 1 <-> 2 is a cycle; 3, 4 and 5 hang off it and reach no root either.
    const depths = Array.from(assignDepth(Int32Array.from([-1, 2, 1, 1, 3, 4]), 6));
    expect(depths).toEqual([0, -1, -1, -1, -1, -1]);
  });
  it('walks a 100k-deep chain iteratively, with no recursion', () => {
    const n = 100000;
    const parentOf = new Int32Array(n);
    for (let i = 0; i < n; i++) parentOf[i] = i === 0 ? -1 : i - 1;
    const depths = assignDepth(parentOf, n);
    expect(depths[n - 1]).toBe(n - 1);
    expect(depths[0]).toBe(0);
  });

  // assignDepth walks each node up to a settled ancestor rather than BFS-ing
  // down from the roots, so it agrees with the obvious implementation only if
  // every settle is classified correctly: hit a root, hit a solved node, or run
  // back onto the current path. Checked against that implementation on graphs
  // that are deliberately full of cycles.
  it('agrees with a breadth-first reference on cyclic graphs', () => {
    const reference = parentOf => {
      const n = parentOf.length;
      const children = Array.from({ length: n }, () => []);
      for (let i = 0; i < n; i++) {
        if (parentOf[i] !== -1) children[parentOf[i]].push(i);
      }
      const depth = new Array(n).fill(-1);
      const queue = [];
      for (let i = 0; i < n; i++) {
        if (parentOf[i] === -1) { depth[i] = 0; queue.push(i); }
      }
      for (let head = 0; head < queue.length; head++) {
        for (const child of children[queue[head]]) {
          if (depth[child] === -1) { depth[child] = depth[queue[head]] + 1; queue.push(child); }
        }
      }
      return depth;
    };

    const rand = rng(4242);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const parentOf = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const roll = rand();
        parentOf[i] = roll < 0.2 ? -1 : Math.floor(rand() * n);
      }
      expect(Array.from(assignDepth(parentOf, n))).toEqual(reference(parentOf));
    }
  });
});

describe('pass 2 end to end', () => {
  // The invariant the atlas depends on: after pass 2 every node reaches a root,
  // so depth is defined everywhere and Task 6's depth cap has a tree to walk.
  it('leaves no node without a depth after selection and cycle breaking', () => {
    const n = 3000;
    const rand = rng(20261014);
    const parentsByChild = new Array(n);
    for (let i = 0; i < n; i++) {
      const candidates = new Set();
      const count = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < count; k++) {
        // Mostly upward edges, plus a few back edges so cycles really form.
        const parent = rand() < 0.9
          ? Math.floor(rand() * i)
          : Math.floor(rand() * n);
        candidates.add(Math.min(parent, n - 1));
      }
      parentsByChild[i] = [...candidates];
    }
    parentsByChild[0] = [];
    parentsByChild[1] = [0];

    const { primary, demoted } = selectPrimaryParents(parentsByChild, n);
    const fixed = breakCycles(primary, demoted, n);
    const depths = assignDepth(fixed, n);

    expect(Array.from(depths).every(d => d >= 0)).toBe(true);
    expect(depths[0]).toBe(0);

    // Every primary edge that survived is a genuine input edge, and no primary
    // edge is duplicated into demoted.
    const demotedKeys = new Set(demoted.map(d => `${d.child}<${d.parent}`));
    for (let i = 0; i < n; i++) {
      if (fixed[i] === -1) continue;
      expect(parentsByChild[i]).toContain(fixed[i]);
      expect(demotedKeys.has(`${i}<${fixed[i]}`)).toBe(false);
    }
  });

  // Byte-identical across repeated runs, for every output the pass produces —
  // not just the parent array.
  it('is byte-identical across repeated runs', () => {
    const build = () => {
      const n = 2000;
      const rand = rng(99);
      const parentsByChild = new Array(n);
      for (let i = 0; i < n; i++) {
        const candidates = new Set();
        const count = Math.floor(rand() * 5);
        for (let k = 0; k < count; k++) candidates.add(Math.min(Math.floor(rand() * n), n - 1));
        parentsByChild[i] = [...candidates];
      }
      const { primary, demoted, sizes } = selectPrimaryParents(parentsByChild, n);
      const fixed = breakCycles(primary, demoted, n);
      return JSON.stringify([
        Array.from(primary), demoted, Array.from(sizes),
        Array.from(fixed), Array.from(assignDepth(fixed, n)),
      ]);
    };
    const first = build();
    expect(first).toBe(build());
  });
});
