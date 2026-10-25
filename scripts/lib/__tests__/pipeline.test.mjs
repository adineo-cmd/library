import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../../build-artifacts.mjs';
import { loadConcepts, loadCrosslinks, parseLayout } from '../../../src/lib/artifacts/load';

const PARAMS = {
  // 5 keeps this whole fixture. On subtree totals Natural sciences (310),
  // Information theory (100), Chemistry (90), Physics (70) and Thermodynamics
  // (60) are the five largest, so all of them survive and the cross-link below
  // has both endpoints. A target of 3 used to work under direct-count ranking,
  // which kept the three leafiest and restored the rest; subtree ranking keeps
  // the trunk first and would drop Thermodynamics (60) at 3.
  nodeTarget: 5, maxDepth: 5,
  crosslinkMinArticleCount: 1, crosslinkMinShared: 1,
  crosslinkTopK: 20, crosslinkGlobalCap: 1000, crosslinkMemberSample: 200,
  metaFilterPatterns: [],
};

let result;

beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'atlas-pipeline-'));
  result = await buildAll({
    outDir,
    dbPath: join(outDir, 'test.db'),
    buildDb: async () => {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(join(outDir, 'test.db'));
      db.exec('CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, cat_pages INTEGER NOT NULL DEFAULT 0)');
      db.exec('CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)');
      db.exec('CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)');
      const insCat = db.prepare('INSERT INTO cat(id,name,cat_pages) VALUES (?,?,?)');
      const insParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
      const insMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');
      // 1 Natural sciences (root)
      //   2 Physics   3 Thermodynamics   4 Information theory   5 Chemistry
      // 6 CS1 references is filtered upstream and must not appear.
      // Subtree totals put all five subject categories above the 5-node cut,
      // and the trunk is kept on its own merit rather than pulled back by a
      // high-count descendant.
      insCat.run(1, 'Natural sciences', 50);
      insCat.run(2, 'Physics', 10);
      insCat.run(3, 'Thermodynamics', 60);
      insCat.run(4, 'Information theory', 100);
      insCat.run(5, 'Chemistry', 90);
      insCat.run(6, 'CS1 references', 5);
      insParent.run(2, 1); insParent.run(3, 2); insParent.run(4, 1); insParent.run(5, 1);
      for (const a of ['e1', 'e2', 'e3']) insMember.run(a, 3);
      for (const a of ['e1', 'e2', 'e3', 'e9']) insMember.run(a, 4);
      insMember.run('c1', 2); insMember.run('c2', 2); insMember.run('c3', 2);
      insMember.run('c1', 5);
      db.close();
    },
    params: PARAMS,
  });
}, 30_000);

describe('buildAll end to end', () => {
  it('produces every artifact file', () => {
    for (const f of ['concepts.json', 'crosslinks.json', 'layout.bin', 'meta.json']) {
      expect(result.files[f]).toBe(true);
    }
  });
  it('emits concepts that pass frontend validation', () => {
    expect(() => loadConcepts(result.concepts)).not.toThrow();
  });
  it('emits crosslinks that pass frontend validation', () => {
    expect(() => loadCrosslinks(result.crosslinks)).not.toThrow();
  });
  it('emits a layout whose byte length matches the declared node count', () => {
    const c = loadConcepts(result.concepts);
    const x = loadCrosslinks(result.crosslinks);
    // The tree is a forest: derive rootCount, never assume 1.
    const rootCount = c.nodes.filter(n => n.parent === -1).length;
    expect(parseLayout(result.layoutBuffer, c.nodeCount, rootCount, x.edges.length).x)
      .toHaveLength(c.nodeCount);
  });
  it('filters the CS1 maintenance category', () => {
    expect(result.concepts.nodes.map(n => n.name)).not.toContain('CS1 references');
  });
  it('finds the Thermodynamics / Information theory cross-link', () => {
    const byName = new Map(result.concepts.nodes.map((n, i) => [n.name, i]));
    const a = byName.get('Thermodynamics');
    const b = byName.get('Information theory');
    expect(result.crosslinks.edges.some(
      e => (e.a === a && e.b === b) || (e.a === b && e.b === a),
    )).toBe(true);
  });
  it('respects the node target', () => {
    expect(result.concepts.nodes.length).toBeLessThanOrEqual(PARAMS.nodeTarget + 5);
  });
  it('keeps every node within the depth cap', () => {
    expect(Math.max(...result.concepts.nodes.map(n => n.depth))).toBeLessThanOrEqual(PARAMS.maxDepth);
  });
});

/**
 * The meta filter at graph time, end to end.
 *
 * The scenario the whole change exists for: a maintenance category sitting in
 * the middle of the hierarchy. Under the old design ingest dropped it, its
 * child never received a parent edge, and that child became a second root —
 * which is how 18.1% of atlas roots came to be maintenance scaffolding. Here
 * the child is spliced up to its grandparent and the forest keeps one root.
 *
 * If the splice were skipped and the node simply dropped, `Physics` would be a
 * root: this test would report two roots instead of one. If the splice handed
 * back an index the compaction did not remap, `Physics.parent` would be an
 * index nobody emitted and `loadConcepts` would throw on the out-of-range
 * parent. Both failure modes are caught; neither is caught by the counts.
 */
const SPLICE_PARAMS = {
  ...PARAMS, nodeTarget: 3,
};

describe('buildAll with a maintenance category mid-hierarchy', () => {
  let spliced;

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'atlas-splice-'));
    spliced = await buildAll({
      outDir,
      dbPath: join(outDir, 'test.db'),
      buildDb: async () => {
        const { default: Database } = await import('better-sqlite3');
        const db = new Database(join(outDir, 'test.db'));
        db.exec('CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, cat_pages INTEGER NOT NULL DEFAULT 0)');
        db.exec('CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)');
        db.exec('CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)');
        const insCat = db.prepare('INSERT INTO cat(id,name,cat_pages) VALUES (?,?,?)');
        const insParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
        const insMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');
        // 1 Natural sciences  (root, 50)
        // 2 CS1 references     (90) — maintenance, removed at graph time
        // 3 Physics            (10) — parented under the removed node
        // 4 Thermodynamics     (60)
        // 5 Chemistry          (90)
        insCat.run(1, 'Natural sciences', 50);
        insCat.run(2, 'CS1 references', 90);
        insCat.run(3, 'Physics', 10);
        insCat.run(4, 'Thermodynamics', 60);
        insCat.run(5, 'Chemistry', 90);
        insParent.run(2, 1); insParent.run(3, 2); insParent.run(4, 3); insParent.run(5, 4);
        insMember.run('a1', 2); insMember.run('a2', 2);
        insMember.run('a1', 3); insMember.run('a3', 4);
        insMember.run('a3', 5);
        db.close();
      },
      params: SPLICE_PARAMS,
    });
  }, 30_000);

  it('removes the maintenance node', () => {
    expect(spliced.concepts.nodes.map(n => n.name)).not.toContain('CS1 references');
  });

  it('re-parents its child to the grandparent instead of orphaning it', () => {
    const byName = new Map(spliced.concepts.nodes.map(n => [n.name, n]));
    expect(byName.get('Physics').parent)
      .toBe(spliced.concepts.nodes.indexOf(byName.get('Natural sciences')));
    expect(byName.get('Physics').depth).toBe(1);
  });

  it('leaves exactly one root, and it is a subject', () => {
    const roots = spliced.concepts.nodes.filter(n => n.parent === -1);
    expect(roots.map(n => n.name)).toEqual(['Natural sciences']);
  });

  it('counts the maintenance node in rawCategories but not afterMetaFilter', () => {
    // The two counters finally mean different things, which is the whole point
    // of moving the filter: 5 categories on disk, 4 offered to passes 2-5.
    // Of those 4 the cut keeps 3 (Natural sciences 210, Physics 160 and
    // Thermodynamics 150 by subtree total) and drops Chemistry's 90. Nothing
    // is restored: on subtree totals the trunk wins its own slot outright,
    // which is why finalNodes equals the target with restoredAncestors at 0.
    expect(spliced.meta.counts.rawCategories).toBe(5);
    expect(spliced.meta.counts.afterMetaFilter).toBe(4);
    expect(spliced.meta.counts.finalNodes).toBe(3);
  });

  it('emits concepts that pass frontend validation', () => {
    // The out-of-range-parent check: a splice that returned a removed index
    // would survive every assertion above and die here instead.
    expect(() => loadConcepts(spliced.concepts)).not.toThrow();
  });
});
