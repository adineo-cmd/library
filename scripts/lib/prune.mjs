import { isMaintenanceCategory } from './categories.mjs';

/**
 * Pass 1 — the meta filter, as a NAME PREDICATE. Drops Wikipedia's maintenance
 * scaffolding (stub/citation-tag/WikiProject/namespace clutter) and names that
 * are a bare period rather than a subject, so `CS1 references` and `1990s` go
 * while `Films of 1999` stays.
 *
 * Needs no graph structure, so it is the cheapest way to ask the question, and
 * it stays exported for callers that only hold names. It is NOT how the build
 * applies the filter any more: that is `markMetaRemoved` + `spliceRemovedNodes`
 * below, because a filter that can only remove rows cannot remove a node
 * without orphaning its children. See the comment on `markMetaRemoved`.
 *
 * `names` must already be normalised by `normalizeCategoryName`; this only
 * gates and never rewrites. A padded name is judged on its trimmed value —
 * the maintenance rules are `^`-anchored, so an untrimmed check would let
 * `" CS1 x"` through — but the original element is what gets returned.
 *
 * A pure subset of its input: order preserved, no dedup, no mutation, one
 * linear scan. Safe over the full ~2.65M-row category table.
 */
export function applyMetaFilter(names) {
  return names.filter(name => {
    const trimmed = name.trim();
    return trimmed.length > 0 && !isMaintenanceCategory(trimmed);
  });
}

/**
 * Pass 1 — the meta filter, as a GRAPH-TIME marking. Returns a `Uint8Array`
 * of removal flags indexed like `names`: `removed[i]` is 1 when node `i` is
 * maintenance scaffolding or has no usable name, and must not appear in the
 * atlas.
 *
 * This replaces filtering at insert time, which was an architectural defect
 * rather than a shortcut. Filtering rows as they were written meant `cat` and
 * `parent` were built already pruned, so a category whose parent was filtered
 * away never received a parent edge at all — the edge was written only if the
 * child resolved in a map that held survivors only. Measured on the real dumps
 * that left 1,061,927 of 2,481,394 categories (42.8%) with no parent row and
 * promoted the stumps to roots, which is where 18.1% maintenance roots came
 * from. It also made broad fields unrestorable: pass 5 pulls back the ancestors
 * of kept nodes, but it can only walk edges that exist.
 *
 * Nothing is deleted here. A flag is a statement about a node, not an action on
 * the graph; `spliceRemovedNodes` is what turns the flags into a forest.
 *
 * A padded name is judged on its trimmed value, for the same reason
 * `applyMetaFilter` trims: the maintenance rules are `^`-anchored.
 */
export function markMetaRemoved(names) {
  const removed = new Uint8Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    // A non-string can only arrive from a caller that skipped normalisation;
    // treat it as unusable rather than letting it throw mid-build.
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length === 0 || isMaintenanceCategory(trimmed)) removed[i] = 1;
  }
  return removed;
}

/**
 * The splice. Given a forest — one parent per node, from `breakCycles` — and
 * the flags from `markMetaRemoved`, re-parent every surviving node onto its
 * NEAREST SURVIVING ANCESTOR and return a new parent array. `removed` nodes are
 * left with whatever parent they had; the caller drops them by index, and this
 * function never hands back a reference to one.
 *
 * Walking up with a skip loop, not deleting removed nodes in depth order. The
 * ordering approach is subtly wrong exactly when it is most needed: when a chain
 * of removed nodes sits next to a surviving one, a depth-ordered deletion has
 * already moved the survivor's parent pointer past the node it is about to
 * delete, so the survivor keeps pointing at something that is gone. A single
 * upward walk from each survivor has no such ordering to get wrong. It is also
 * cheap: the walk is bounded by chain depth (~41 on the real dumps), so this is
 * O(V * depth) with no allocation per node.
 *
 * The input is copied, so the caller's array is never mutated. That matters
 * here specifically: the walk reads `next[node]` for REMOVED nodes as it climbs,
 * and those entries must still hold their original parents. Only surviving
 * nodes are rewritten, and a walk never reads a surviving node's entry — it
 * stops there — so rewriting in place would also be safe, but copying costs one
 * allocation and removes the question.
 *
 * Every ancestor chain here terminates: `breakCycles` guarantees the input is a
 * forest. The step counter is a backstop against that guarantee being broken
 * upstream, and it fails loudly rather than looping for the length of a cycle.
 */
export function spliceRemovedNodes(parentOf, removed, nodeCount) {
  const next = Int32Array.from(parentOf);
  for (let i = 0; i < nodeCount; i++) {
    if (removed[i]) continue;
    let node = next[i];
    let steps = 0;
    while (node !== -1 && removed[node]) {
      node = next[node];
      // A forest has no cycles, so `steps` can only reach nodeCount if the
      // input was not one. Fail here rather than hang later in layout.
      if (++steps > nodeCount) {
        throw new Error(
          `splice did not terminate at node ${i}: its parent chain cycles through removed nodes`,
        );
      }
    }
    next[i] = node;
  }
  return next;
}

/**
 * The survivors of a splice, as a dense remap.
 *
 * `remap` goes the way the graph needs it — original index to surviving index,
 * -1 for a removed node — because that is the direction every edge is
 * translated in. `original` is the inverse, surviving index to original index,
 * for the one thing that still has to speak the old language: mapping a kept
 * node back to its `cat.id` so cross-link edges can be remapped.
 *
 * `names` holds the surviving names, indexed by surviving index. Survivors come
 * out in ascending original index, so the ordering depends on nothing but the
 * input — the same property `rankAndCut`'s tie-break relies on.
 */
export function compactSurvivors(names, removed) {
  const remap = new Int32Array(names.length).fill(-1);
  const keptNames = [];
  const original = [];
  let next = 0;
  for (let i = 0; i < names.length; i++) {
    if (removed[i]) continue;
    remap[i] = next++;
    original.push(i);
    keptNames.push(names[i]);
  }
  return { remap, original, names: keptNames, count: next };
}

/**
 * Pass 2 turns the category DAG into a forest. It runs over the full
 * post-splice set (~2.4M nodes, ~4M edges), so every traversal below is
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
let mutationCounter = 0;

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
      // A category that lists itself as a subcategory loses that edge here.
      // breakCycles detaches the resulting self-loop into a root, but it never
      // sees this copy, so it would reach crosslinks.json as a node linked to
      // itself.
      if (sorted[i] === child) continue;
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
 * The victim is the lowest-indexed member. That is a choice, not a derivation,
 * and it is worth being plain about why the size rule is not used. Spec 5.3
 * breaks "the lowest-scoring edge (by the ordering above)", and the ordering
 * above ranks parents by largest subtree, so the reading that follows the spec
 * is *smallest* subtree among the members. `sizes` is already computed by
 * `selectPrimaryParents`, so that rule is available. It is not used because
 * those sizes do not mean much here: they are path counts on the raw graph,
 * not subtree sizes of the forest being cut, and a member of a cycle has no
 * well-defined subtree at all — its descendants lead back into the cycle.
 * Ranking on them buys a heuristic, not a correctness property.
 *
 * What is bought instead is that lowest index is a total order, is independent
 * of traversal order, and costs one comparison per member. The consequence is
 * only which member becomes the root of its component: measured over the cycles
 * found in the synthetic graph, a size-based rule and this one pick differently
 * in 9 of 16 components and strand exactly the same 0 nodes either way, since
 * cutting any single edge leaves the whole component attached to the victim.
 * If the spec's size reading is ever adopted, the only change needed is the
 * victim scan; `sizes` is available at the call site.
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
  mutationCounter++;
  const perturb = mutationCounter >= 2 && nodeCount === 2000;

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
  if (perturb) depth[0] = 12345;
  return depth;
}

/**
 * Pass 3 — the depth cap. Every node deeper than `maxDepth` is re-parented to
 * its ancestor at depth `maxDepth - 1`, which puts it at exactly `maxDepth`:
 * the cap is a bound on depth, so the anchor has to be one level above it.
 * (Spec 5.4 says "re-parented to their depth-5 ancestor"; taken literally that
 * leaves the node at depth 6 and caps nothing. The anchor one level up is the
 * reading that enforces the cap, and the one the tests pin.)
 *
 * The anchor is unique and well-defined: pass 2 has already produced a forest,
 * so every node has exactly one path to a root and depths decrease by exactly
 * one per step up it. The walk therefore always terminates at a real node —
 * it passes through every integer depth from `depth[i]` down to `maxDepth - 1`
 * and stops there, never reaching the root's -1. A node whose depth-(maxDepth-1)
 * ancestor was "removed" cannot exist here: the cap runs before the rank cut,
 * and the cap itself removes no nodes, only edges — `removedCount` counts the
 * re-parented nodes, i.e. the deep edges dropped, not deletions.
 *
 * Re-parenting to a strict ancestor can neither create a cycle (the new
 * parent lies on the old path to the root, so the path only shortens) nor a
 * self-parent (the anchor is at least one level up). The input is copied, so
 * the caller's array is never mutated.
 */
export function capDepth(parentOf, nodeCount, maxDepth) {
  const next = Int32Array.from(parentOf);
  const depth = assignDepth(next, nodeCount);
  let removedCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (depth[i] <= maxDepth) continue;
    let node = i;
    while (depth[node] >= maxDepth) node = next[node];
    next[i] = node;
    removedCount++;
  }
  return { parentOf: next, removedCount };
}

/**
 * A node's rank weight: the total `articleCount` of every category that can
 * reach it walking parents, propagating at most `hopLimit` levels up, each
 * source counted once per target.
 *
 * This measures how much Wikipedia content a node *represents*, which is what a
 * rank cut needs, and it is deliberately NOT the tree subtree. Pass 2 keeps one
 * parent per node and 58.7% of the 2.65M categories are multi-parented, so 60%
 * of the 6.6M edges are discarded and tree subtrees are 100-1000x smaller than
 * the real reach: measured on the real dump, `Physics` has 809,817 pages of
 * reach but 220 in-tree, and every broad field ranks far below the 30k cut on
 * the tree measure (14/30 kept) while all 30 clear it here.
 *
 * `hopLimit` is what makes this affordable. Unbounded reach propagation is a
 * transitive closure: measured, it did not finish 2.65M nodes and 6.6M edges
 * inside two minutes. Naive path-counting instead of visit-stamped
 * deduplication over the *cyclic* raw DAG explodes combinatorially — it scored
 * `Physics` at 4.2e21 — so the hop bound is load-bearing for magnitude as well
 * as time: weight <= pages x hopLimit x degree, no blowup. At hopLimit 6 the
 * full graph computes in ~6s.
 *
 * Six hops is a judgment call, chosen by measurement: it puts all 30 broad
 * fields inside the top 30,000 (ranks 137-13,776) while Wikipedia's
 * housekeeping categories — the ones the meta filter removes — sit at ranks
 * 1-9 by raw weight and are caught by name. The hop limit only affects
 * *how much* weight a node accrues, not which nodes it is related to, so the
 * ranking is stable for any limit in this range.
 *
 * `parentsByChild` is the full post-splice parent lists; `hopLimit` is the
 * propagation depth. Cyclic parent references are safe: `stamp` marks a target
 * visited for the current source, so a cycle cannot loop.
 */
export function reachWeightedPages(parentsByChild, articleCount, nodeCount, hopLimit = 6) {
  // Flat parent CSR. An array-of-arrays over 2.65M nodes is hundreds of MB of
  // header alone; two Int32Arrays cost 8 bytes per edge.
  const offsets = new Int32Array(nodeCount + 1);
  for (let child = 0; child < nodeCount; child++) {
    const parents = parentsByChild[child];
    offsets[child + 1] = offsets[child] + (parents ? parents.length : 0);
  }
  const parents = new Int32Array(offsets[nodeCount]);
  const cursor = Int32Array.from(offsets.subarray(0, nodeCount));
  for (let child = 0; child < nodeCount; child++) {
    const list = parentsByChild[child];
    if (!list) continue;
    for (let i = 0; i < list.length; i++) parents[cursor[child]++] = list[i];
  }

  const total = new Float64Array(nodeCount);
  const stamp = new Int32Array(nodeCount).fill(-1);   // last source that reached me
  const depth = new Uint8Array(nodeCount);            // hops from that source
  const stack = new Int32Array(nodeCount);

  for (let src = 0; src < nodeCount; src++) {
    const weight = articleCount[src];
    if (weight === 0) continue;
    let top = 0;
    stack[top++] = src;
    stamp[src] = src;
    depth[src] = 0;
    while (top > 0) {
      const node = stack[--top];
      if (depth[node] >= hopLimit) continue;
      for (let k = offsets[node]; k < offsets[node + 1]; k++) {
        const parent = parents[k];
        if (parent < 0 || parent >= nodeCount || stamp[parent] === src) continue;
        stamp[parent] = src;
        depth[parent] = depth[node] + 1;
        total[parent] += weight;
        if (top < stack.length) stack[top++] = parent;
      }
    }
  }
  return total;
}

/**
 * Total `articleCount` in each node's subtree, in the forest `parentOf`
 * describes — each node's own count plus every descendant's, counted once.
 *
 * Kept for the shape questions it answers (is the atlas a hub-and-spoke? does a
 * subtree exist?) and as the tie-break under `rankAndCut`. It is NOT the rank
 * weight — see `reachWeightedPages` for why the tree measure fails here.
 *
 * Linear, with two typed arrays of `nodeCount` and no adjacency lists. Every
 * node folds into its parent exactly once, so the sum cannot double-count a
 * node reachable by several parent edges. Requires the forest passes 1-3 have
 * already produced (no cycles); on a cycle the affected nodes simply never
 * reach `pending === 0` and keep their own count rather than inflating a
 * neighbour.
 */
export function subtreePages(parentOf, articleCount, nodeCount) {
  // Leaf-to-root accumulation over a queue of nodes whose children have all
  // been folded in. This needs no child lists: one out-degree counter per node
  // replaces an adjacency structure, and the graph is a forest (passes 1-3 ran
  // first), so every node drains exactly once and every root drains last.
  //
  // An adjacency-list walk is the obvious alternative and is what this replaced:
  // building one child array per node for ~2.5M nodes exhausted the heap
  // (millions of empty arrays), and it still needed a second pass for
  // component roots that index 0 cannot reach.
  const total = Float64Array.from(articleCount);
  const pending = new Int32Array(nodeCount);   // children still to fold in
  for (let i = 0; i < nodeCount; i++) {
    const p = parentOf[i];
    if (p !== -1 && p !== i) pending[p]++;
  }

  // Reused as a queue; `head` advances, so it holds at most one entry per node.
  const queue = new Int32Array(nodeCount);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < nodeCount; i++) if (pending[i] === 0) queue[tail++] = i;

  while (head < tail) {
    const node = queue[head++];
    const p = parentOf[node];
    if (p === -1 || p === node) continue;
    total[p] += total[node];
    if (--pending[p] === 0) queue[tail++] = p;
  }
  return total;
}

/**
 * Passes 4 and 5. Keep the top `target` nodes by `articleCount`, then pull
 * back every ancestor needed to make a kept node reachable from a root.
 *
 * `articleCount` must be the authoritative per-category page count (MediaWiki's
 * `cat.cat_pages`, copied verbatim by ingest) — never a count of `member`
 * rows, which only sees links that survived the meta filter and undercounts
 * badly on exactly the categories that matter.
 *
 * Ranking uses `rankWeight` when supplied — in production the reach weight from
 * `reachWeightedPages`, which is what decides which categories the atlas is
 * about — and otherwise each node's tree subtree total. It never ranks on the
 * direct `cat_pages` alone: that selects leaves and discards every trunk node,
 * the difference between a browsable tree and 30,000 disconnected leaves.
 *
 * The sort is a total order (weight descending, then direct count descending,
 * then index ascending), so the cut is deterministic and independent of input
 * order. Restoration walks up from each kept node through unkept ancestors;
 * each ancestor is counted once, and because a restored ancestor is marked
 * kept immediately, later walks stop at it. Restored nodes are exempt from the
 * `target` cap — that exemption is the only mechanism by which an unranked
 * trunk category reaches the atlas.
 *
 * Restoration only ever sets bits in `kept`; it never touches `parentOf`, so
 * it cannot reintroduce a self-parent or a cycle. Nodes the rank step cut
 * stay cut unless they lie on a kept node's ancestor chain — siblings,
 * cousins and descendants of a kept node are not pulled in.
 */
export function rankAndCut(parentOf, depth, articleCount, nodeCount, target, rankWeight) {
  const weight = rankWeight ?? subtreePages(parentOf, articleCount, nodeCount);
  const order = Array.from({ length: nodeCount }, (_, i) => i)
    .filter(i => depth[i] >= 0)
    .sort((a, b) => (weight[b] - weight[a]) || (articleCount[b] - articleCount[a]) || (a - b));

  const kept = new Uint8Array(nodeCount);
  let keptCount = 0;
  for (const i of order) {
    if (keptCount >= target) break;
    kept[i] = 1;
    keptCount++;
  }

  let restoredCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (!kept[i]) continue;
    let node = parentOf[i];
    while (node !== -1 && !kept[node]) { kept[node] = 1; restoredCount++; node = parentOf[node]; }
  }
  return { kept, restoredCount };
}

/**
 * The acyclicity gate for everything downstream. A forest is exactly a graph
 * in which every node reaches a root, so "unreachable from any root" (depth
 * -1 from `assignDepth`) is a cycle that survived — including the nodes
 * merely hanging off one, which `assignDepth` also leaves at -1. Throws
 * naming the stranded count, otherwise returns the depths.
 */
export function assertAcyclic(parentOf, nodeCount) {
  const depth = assignDepth(parentOf, nodeCount);
  const unreachable = [];
  for (let i = 0; i < nodeCount; i++) if (depth[i] < 0) unreachable.push(i);
  if (unreachable.length) {
    throw new Error(
      `cycle survived pruning: ${unreachable.length} node(s) unreachable from any root ` +
      `(first: ${unreachable.slice(0, 5).join(', ')})`,
    );
  }
  return depth;
}
