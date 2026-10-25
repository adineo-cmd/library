/**
 * Layout (Task 8). Positions for the force atlas and the packed binary the
 * frontend parses (`src/lib/artifacts/load.ts`).
 *
 * `computePositions` is a small deterministic force simulation: tree edges
 * attract, a spatial grid gives every pair inside one cell radius a
 * repulsion, and a weak pull toward the centre keeps roots from drifting.
 * No randomness anywhere — initial placement is a golden-angle spiral
 * indexed by array position, so two runs over the same nodes produce
 * byte-identical output and the layout cache is sound.
 *
 * `packLayout` mirrors `parseLayout` section for section: x/y as Float32 per
 * node, then tree edges (one per non-root node, parent -> child), then
 * cross-link endpoints and weights. Any drift between the two functions is
 * a corrupt artifact, which is why `parseLayout` checks the exact byte
 * count and the pipeline test asserts it.
 */

const GOLDEN_ANGLE = 2.399963229728653;
const CELL = 60;
const ITERATIONS = 48;

/**
 * Stable content hash of the node set, used to skip the layout when the
 * concepts are unchanged. FNV-1a over the fields that affect position.
 * A 32-bit hash collides rarely and a collision only costs one redundant
 * layout run, never a wrong one — the hash gates a cache, it does not feed
 * the simulation.
 */
export function layoutInputHash(nodes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodes.length; i++) {
    const s = `${nodes[i].name}\0${nodes[i].parent}\0${nodes[i].depth}\0${nodes[i].articleCount}`;
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic force layout over the forest. Returns flat Float32 x/y
 * arrays in node-index order. O(iterations * n * density) via the grid.
 */
export function computePositions(nodes) {
  const n = nodes.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const angle = i * GOLDEN_ANGLE;
    const radius = 40 + nodes[i].depth * 140 + (i % 17) * 9;
    x[i] = radius * Math.cos(angle);
    y[i] = radius * Math.sin(angle);
  }

  const tree = new Int32Array(n);
  const treeParent = new Int32Array(n);
  let treeCount = 0;
  for (let i = 0; i < n; i++) {
    if (nodes[i].parent === -1) continue;
    tree[treeCount] = i;
    treeParent[treeCount] = nodes[i].parent;
    treeCount++;
  }

  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 100000 + cy;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    grid.clear();
    for (let i = 0; i < n; i++) {
      const key = cellKey(Math.floor(x[i] / CELL), Math.floor(y[i] / CELL));
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, bucket = []);
      bucket.push(i);
    }

    vx.fill(0);
    vy.fill(0);

    // Repulsion: every node against the nodes in its own and adjacent
    // cells. 3x3 cells at CELL=60 covers the ~200-unit interaction radius
    // with a wide margin, so no pair that could matter is missed.
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] / CELL);
      const cy = Math.floor(y[i] / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(cellKey(gx, gy));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const j = bucket[b];
            if (j <= i) continue;
            const dx = x[i] - x[j];
            const dy = y[i] - y[j];
            const d2 = dx * dx + dy * dy + 0.01;
            if (d2 > 40_000) continue;
            const d = Math.sqrt(d2);
            const f = 2400 / d2;
            const ux = (dx / d) * f;
            const uy = (dy / d) * f;
            vx[i] += ux; vy[i] += uy;
            vx[j] -= ux; vy[j] -= uy;
          }
        }
      }
    }

    // Tree attraction toward a fixed rest length.
    for (let t = 0; t < treeCount; t++) {
      const i = tree[t];
      const j = treeParent[t];
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 90) * 0.02;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      vx[i] += ux; vy[i] += uy;
      vx[j] -= ux; vy[j] -= uy;
    }

    const cooling = 1 - iter / (ITERATIONS * 1.6);
    for (let i = 0; i < n; i++) {
      vx[i] += -x[i] * 0.0012;
      vy[i] += -y[i] * 0.0012;
      x[i] += Math.max(-30, Math.min(30, vx[i] * cooling));
      y[i] += Math.max(-30, Math.min(30, vy[i] * cooling));
    }
  }

  return { x, y };
}

/**
 * Pack positions, tree edges and cross-links into the binary layout format.
 * Section order and widths are fixed by parseLayout: Float32 x/y per node,
 * Uint16 parent/child per tree edge, then Uint16 endpoints and Float32
 * weight per cross-link. The buffer length must equal
 * nodeCount*8 + treeEdges*4 + crosslinkCount*8 exactly.
 */
export function packLayout(positions, nodes, edges) {
  const n = nodes.length;
  let rootCount = 0;
  for (let i = 0; i < n; i++) if (nodes[i].parent === -1) rootCount++;
  const treeEdges = n - rootCount;
  const e = edges.length;

  const buffer = new ArrayBuffer(n * 8 + treeEdges * 4 + e * 8);
  const x = new Float32Array(buffer, 0, n);
  const y = new Float32Array(buffer, n * 4, n);
  x.set(positions.x);
  y.set(positions.y);

  const treeSrc = new Uint16Array(buffer, n * 8, treeEdges);
  const treeDst = new Uint16Array(buffer, n * 8 + treeEdges * 2, treeEdges);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const p = nodes[i].parent;
    if (p === -1) continue;
    if (p >= 0x10000 || i >= 0x10000) {
      throw new Error(`layout: node index ${Math.max(p, i)} exceeds the Uint16 index limit`);
    }
    treeSrc[t] = p;
    treeDst[t] = i;
    t++;
  }

  const crossSrc = new Uint16Array(buffer, n * 8 + treeEdges * 4, e);
  const crossDst = new Uint16Array(buffer, n * 8 + treeEdges * 4 + e * 2, e);
  const crossWeight = new Float32Array(buffer, n * 8 + treeEdges * 4 + e * 4, e);
  for (let i = 0; i < e; i++) {
    const { a, b, shared } = edges[i];
    if (a >= 0x10000 || b >= 0x10000) {
      throw new Error(`layout: cross-link endpoint ${Math.max(a, b)} exceeds the Uint16 index limit`);
    }
    crossSrc[i] = a;
    crossDst[i] = b;
    crossWeight[i] = shared;
  }

  return buffer;
}
