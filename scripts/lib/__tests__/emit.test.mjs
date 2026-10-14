import { describe, it, expect } from 'vitest';
import { buildConceptsFile, buildCrosslinksFile, buildMeta } from '../emit.mjs';
import { loadConcepts, loadCrosslinks, loadMeta } from '../../../src/lib/artifacts/load';

const nodes = [
  { id: 'physics', name: 'Physics', parent: -1, depth: 0, articleCount: 100, aliases: [] },
  { id: 'thermo', name: 'Thermodynamics', parent: 0, depth: 1, articleCount: 50, aliases: [] },
];

describe('buildConceptsFile', () => {
  it('round-trips through the frontend validator', () => {
    const f = buildConceptsFile(nodes, '2026-08-05', '1');
    expect(() => loadConcepts(JSON.parse(JSON.stringify(f)))).not.toThrow();
  });
  it('sets nodeCount from the array length', () => {
    expect(buildConceptsFile(nodes, '2026-08-05', '1').nodeCount).toBe(2);
  });
  it('uses compact parent indices, not id strings', () => {
    expect(buildConceptsFile(nodes, '2026-08-05', '1').nodes[1].parent).toBe(0);
  });

  // Load-bearing for every later task: `parent` is an array index, so the
  // emitted file must have dense 0..n-1 positions and every parent must
  // resolve to a real node — never out of range, never self-referential.
  it('emits dense 0..n-1 indices with valid parent references', () => {
    const f = buildConceptsFile([
      { id: 'root', name: 'Root', parent: -1, depth: 0, articleCount: 10, aliases: [] },
      { id: 'child-a', name: 'Child A', parent: 0, depth: 1, articleCount: 4, aliases: [] },
      { id: 'child-b', name: 'Child B', parent: 0, depth: 1, articleCount: 3, aliases: [] },
      { id: 'grandchild', name: 'Grandchild', parent: 1, depth: 2, articleCount: 2, aliases: [] },
    ], '2026-08-05', '1');

    expect(f.nodeCount).toBe(4);
    expect(f.nodes.map((_, i) => i)).toEqual([0, 1, 2, 3]);
    for (const [i, n] of f.nodes.entries()) {
      expect(n.parent === -1 || (n.parent >= 0 && n.parent < f.nodeCount)).toBe(true);
      expect(n.parent).not.toBe(i);
    }
    // The references are indices into this array: node 3's parent is node 1,
    // and node 1 is Child A — the relationship survives the round-trip.
    expect(f.nodes[3].parent).toBe(1);
    expect(f.nodes[f.nodes[3].parent].id).toBe('child-a');
    expect(() => loadConcepts(JSON.parse(JSON.stringify(f)))).not.toThrow();
  });

  // A missing id falls back to the slugified name, so the id is always
  // non-empty (the schema rejects an empty id) and stable across runs.
  it('falls back to slugify when a node has no id', () => {
    const f = buildConceptsFile([
      { name: 'Physical sciences', parent: -1, depth: 0, articleCount: 17, aliases: [] },
    ], '2026-08-05', '1');
    expect(f.nodes[0].id).toBe('physical-sciences');
    expect(() => loadConcepts(JSON.parse(JSON.stringify(f)))).not.toThrow();
  });

  it('defaults aliases to an empty array', () => {
    const f = buildConceptsFile([
      { id: 'x', name: 'X', parent: -1, depth: 0, articleCount: 1 },
    ], '2026-08-05', '1');
    expect(f.nodes[0].aliases).toEqual([]);
  });
});

describe('buildCrosslinksFile', () => {
  it('round-trips through the frontend validator', () => {
    const f = buildCrosslinksFile([{ a: 0, b: 1, shared: 7 }]);
    expect(() => loadCrosslinks(JSON.parse(JSON.stringify(f)))).not.toThrow();
  });
});

describe('buildMeta', () => {
  it('round-trips and records every parameter', () => {
    const meta = buildMeta(
      { rawCategories: 4000000, afterMetaFilter: 90000, afterDepthCap: 45000,
        finalNodes: 30000, restoredAncestors: 400, crosslinks: 120000,
        danglingCrosslinks: 0 },
      { nodeTarget: 30000, maxDepth: 5, crosslinkMinArticleCount: 10,
        crosslinkMinShared: 3, crosslinkTopK: 20, crosslinkGlobalCap: 400000,
        crosslinkMemberSample: 200, metaFilterPatterns: ['^CS\\d'] },
      '2026-08-05', '1', '2026-10-11T00:00:00Z',
    );
    expect(() => loadMeta(JSON.parse(JSON.stringify(meta)))).not.toThrow();
    expect(meta.counts.finalNodes).toBe(30000);
    expect(meta.params.metaFilterPatterns).toEqual(['^CS\\d']);
    expect(meta.sources.every(s => /^https?:\/\//.test(s.url))).toBe(true);
  });

  // restoredAncestors is the pass-5 bookkeeping: the number of nodes pulled
  // back solely to keep kept nodes reachable. It is reported in meta.json so
  // the /method page can show how much of the atlas is trunk exempt from the
  // node cap.
  it('reports restoredAncestors in counts', () => {
    const meta = buildMeta(
      { rawCategories: 100, afterMetaFilter: 90, afterDepthCap: 80,
        finalNodes: 60, restoredAncestors: 12, crosslinks: 5, danglingCrosslinks: 1 },
      { nodeTarget: 50, maxDepth: 5, crosslinkMinArticleCount: 10,
        crosslinkMinShared: 3, crosslinkTopK: 20, crosslinkGlobalCap: 400000,
        crosslinkMemberSample: 200, metaFilterPatterns: [] },
      '2026-08-05', '1', '2026-10-11T00:00:00Z',
    );
    expect(meta.counts.restoredAncestors).toBe(12);
    expect(meta.counts.finalNodes).toBeGreaterThan(50 - 12);
  });
});
