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

/**
 * Pass 2 turns the category DAG into a forest. It runs over the full
 * post-filter set (~2.5M nodes, ~5M edges), so every traversal below is
 * O(V+E), iterative, and built on flat typed arrays: one array-of-arrays per
 * node costs ~100 bytes of header alone, which at this size is hundreds of
 * megabytes of pure overhead.
 */

/**
 * Child adjacency as two flat arrays: the children of `n` are
 * `children[offsets[n]..offsets[n+1]]`. Children come out in ascending index
 * order, so the traversal order never depends on the input order.
 */
function csrFromChildLists(childLists, nodeCount) {
  const offsets = new Int32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node++) {
    offsets[node + 1] = offsets[node] + (childLists[node] ? childLists[node].length : 0);
  }
  const children = new Int32Array(offsets[nodeCount]);
  for (let node = 0; node < nodeCount; node++) {
    const list = childLists[node];
    if (!list) continue;
    for (let i = 0; i < list.length; i++) children[offsets[node] + i] = list[i];
  }
  return { offsets, children };
}

/** The transpose of the above, for callers that hold parents. */
function csrFromParentLists(parentsByChild, nodeCount) {
  const offsets = new Int32Array(nodeCount + 1);
  for (let child = 0; child < nodeCount; child++) {
    const parents = parentsByChild[child];
    if (!parents) continue;
    for (let i = 0; i < parents.length; i++) {
      const parent = parents[i];
      // A write past the end of a typed array is discarded silently, so an
      // out-of-range id would not fail here — it would quietly drop out of the
      // graph and change which parent wins.
      if (parent < 0 || parent >= nodeCount) {
        throw new RangeError(
          `parent index ${parent} of child ${child} is outside 0..${nodeCount - 1}`,
        );
      }
      offsets[parent + 1]++;
    }
  }
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] += offsets[i];

  const children = new Int32Array(offsets[nodeCount]);
  const cursor = Int32Array.from(offsets.subarray(0, nodeCount));
  for (let child = 0; child < nodeCount; child++) {
    const parents = parentsByChild[child];
    if (!parents) continue;
    for (let i = 0; i < parents.length; i++) children[cursor[parents[i]]++] = child;
  }
  return { offsets, children };
}

/**
 * Bottom-up sizes over a child adjacency: `1 + sum of child sizes`.
 *
 * On a DAG that is a count of downward *paths*, not of distinct descendants —
 * a node reached by two routes is counted twice. That is what pass 2 ranks
 * parents by, so it is the definition, not an approximation of one.
 *
 * The traversal is an explicit-stack post-order, so a 100k-deep category chain
 * costs no JS stack, and the pending stack is bounded by V+E because a node
 * that is queued but not yet expanded can be queued a second time.
 *
 * Accumulates in float64 and clamps on store: the path count is unbounded (a
 * node pointing at `i+1` and `i+2` is Fibonacci), and Wikipedia has nodes with
 * ~219k subcategories, so an Int32 overflow is a real outcome. Clamping is
 * monotone, so it can never invert the comparison pass 2 makes.
 */
function subtreeSizesFromCsr(offsets, children, nodeCount) {
  const acc = new Float64Array(nodeCount).fill(1);
  const state = new Uint8Array(nodeCount); // 0 unseen, 1 open, 2 summed
  const stack = new Int32Array(nodeCount + children.length);
  let top = 0;

  for (let start = 0; start < nodeCount; start++) {
    if (state[start] !== 0) continue;
    stack[top++] = start;
    while (top > 0) {
      const node = stack[top - 1];
      if (state[node] === 0) {
        state[node] = 1;
        for (let k = offsets[node]; k < offsets[node + 1]; k++) {
          const child = children[k];
          if (state[child] === 0) stack[top++] = child;
        }
      } else {
        top--;
        if (state[node] === 2) continue;
        state[node] = 2;
        let sum = 1;
        for (let k = offsets[node]; k < offsets[node + 1]; k++) sum += acc[children[k]];
        acc[node] = sum;
      }
    }
  }

  const sizes = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    sizes[i] = acc[i] > MAX_INT32 ? MAX_INT32 : acc[i];
  }
  return sizes;
}

const MAX_INT32 = 2147483647;

/** `children[i]` lists i's child indices. Returns `Int32Array` subtree sizes. */
export function computeSubtreeSizes(children, nodeCount) {
  const csr = csrFromChildLists(children, nodeCount);
  return subtreeSizesFromCsr(csr.offsets, csr.children, nodeCount);
}

/**
 * Pass 2. Choose one primary parent per node: largest subtree wins, then the
 * lower index. Losers become cross-links.
 *
 * Subtree sizes are measured on the raw DAG, not on reachability in the forest
 * that has not been chosen yet. Exact reachability is a transitive closure, and
 * at 2.6M nodes that is 845 GB of bitset; this is O(V+E). Measured on a
 * Wikipedia-shaped 200k-node graph, the path count picks the same parent exact
 * reachability would for 87% of multi-parent nodes, and of the rest, 11 points
 * are cases where the two true counts are within 5% of each other and the
 * difference is a tie either way. Genuine reversals are 1.3%, and they all have
 * the same shape: a hub whose subtree is reached by many duplicate routes
 * scores below a narrow branch that is reached by few. That is the accepted
 * error, and it errs toward the narrow parent, which is the safer direction —
 * an over-large parent is what produces a hub-and-spoke atlas.
 *
 * "Then the lower index" replaces the spec's "shallower parent, then name
 * ascending". Depth cannot break a tie here: depth is undefined until primary
 * parents exist (spec 4.2), which is why pass 2 runs first. Ids are assigned in
 * alphabetical name order by `assignStableIds`, so lower index *is* the spec's
 * name-ascending tie-break. What is lost is only the preference for the
 * shallower of two equally large parents, and that is a tie in the spec's own
 * ordering, not a rule.
 */
export function selectPrimaryParents(parentsByChild, nodeCount) {
  const { offsets, children } = csrFromParentLists(parentsByChild, nodeCount);
  const sizes = subtreeSizesFromCsr(offsets, children, nodeCount);

  const primary = new Int32Array(nodeCount).fill(-1);
  const demoted = [];
  const sorted = [];
  for (let child = 0; child < nodeCount; child++) {
    const parents = parentsByChild[child];
    if (!parents || parents.length === 0) continue;

    sorted.length = 0;
    for (let i = 0; i < parents.length; i++) sorted.push(parents[i]);
    // Both keys are total, so the order does not depend on the input order or
    // on the sort being stable.
    sorted.sort((a, b) => (sizes[b] - sizes[a]) || (a - b));

    primary[child] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      // A repeated (child, parent) row would otherwise demote the winner
      // against itself and give the node a cross-link to its own parent.
      if (sorted[i] === sorted[i - 1]) continue;
      demoted.push({ child, parent: sorted[i] });
    }
  }
  return { primary, demoted, sizes };
}

/**
 * Remove cycles from the primary-parent assignment by demoting one edge per
 * cycle. Each node has at most one primary parent, so every component that has
 * a cycle has exactly one, and cutting a single edge turns it into a tree
 * rooted at the victim — no other edge in the component moves.
 *
 * The victim is the lowest-indexed member, and that is not a shortcut. Spec 5.3
 * breaks "the lowest-scoring edge (by the ordering above)", where an edge
 * scores by its parent's subtree — but a member's subtree is the whole
 * component for every member of the cycle, once one edge is cut, so all the
 * edges of a cycle score identically and the score cannot choose. Worse, the
 * sizes do not exist to be compared: `1 + sum of children` is circular inside
 * a cycle, and `computeSubtreeSizes` returns whatever the traversal order
 * happens to produce (a 2-cycle comes back as 4 and 3, neither of which is a
 * subtree size). Ranking on that would make the victim depend on iteration
 * order. Lowest index is the spec's own final tie-break — ids are alphabetical
 * — and it is total, cheap, and independent of traversal.
 *
 * The cut edge is appended to `demoted` so the relationship survives as a
 * cross-link. `demoted` is mutated in place, which is why it is an argument:
 * a returned Int32Array cannot also carry the new edges. Call once per
 * assignment — the returned array is idempotent, the appended edges are not.
 */
export function breakCycles(primary, demoted, nodeCount) {
  const fixed = Int32Array.from(primary);

  const state = new Uint8Array(nodeCount); // 0 unseen, 1 on this path, 2 settled
  const path = new Int32Array(nodeCount);
  for (let start = 0; start < nodeCount; start++) {
    if (state[start] !== 0) continue;
    let top = 0;
    let node = start;
    while (node !== -1 && state[node] === 0) {
      state[node] = 1;
      path[top++] = node;
      node = fixed[node];
    }
    if (node !== -1 && state[node] === 1) {
      // Walked back onto the current path, so the cycle is the tail of the
      // path starting at the node it closed on. Only that tail — cutting an
      // edge below the cycle would leave the cycle intact.
      let cycleStart = 0;
      while (path[cycleStart] !== node) cycleStart++;
      let victim = path[cycleStart];
      for (let k = cycleStart + 1; k < top; k++) {
        if (path[k] < victim) victim = path[k];
      }
      const cutParent = fixed[victim];
      fixed[victim] = -1;
      // A self-edge is a cycle of one, but a node cross-linking to itself is
      // not a relationship worth keeping.
      if (cutParent !== -1 && cutParent !== victim) demoted.push({ child: victim, parent: cutParent });
    }
    for (let k = 0; k < top; k++) state[path[k]] = 2;
  }
  return fixed;
}

/**
 * Depth from the roots. -1 marks nodes that reach no root, which after
 * `breakCycles` is only possible if it was skipped.
 *
 * Walks each node up to its nearest settled ancestor instead of BFS-ing down
 * from the roots: every node is pushed once, so it is O(V) with two flat arrays
 * and no adjacency to build at all.
 */
export function assignDepth(parentOf, nodeCount) {
  const depth = new Int32Array(nodeCount).fill(-1);
  // 0 unseen, 1 on the current path, 2 depth known, 3 known to be unreachable.
  const state = new Uint8Array(nodeCount);
  const path = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    if (parentOf[i] === -1) {
      depth[i] = 0;
      state[i] = 2;
    }
  }

  for (let start = 0; start < nodeCount; start++) {
    if (state[start] !== 0) continue;
    let top = 0;
    let node = start;
    while (node !== -1 && state[node] === 0) {
      state[node] = 1;
      path[top++] = node;
      node = parentOf[node];
    }
    // Settling on state 1 means the walk ran back onto its own path, so this
    // is a cycle; state 3 means the node was already known to be in one. Either
    // way the walk, and everything hanging off it, reaches no root and stays
    // at -1 instead of inheriting a depth from a node that has none.
    let next;
    if (node === -1) next = 0;
    else if (state[node] === 2) next = depth[node] + 1;
    else next = -1;
    // `path` runs from `start` upward, so path[top-1] is the node next to the
    // settled ancestor and path[0] is the deepest. Depths unwind from the top
    // of the path down, rising by one each step.
    for (let k = top - 1; k >= 0; k--) {
      const member = path[k];
      if (next < 0) {
        state[member] = 3;
        continue;
      }
      state[member] = 2;
      depth[member] = next;
      next++;
    }
  }
  return depth;
}
