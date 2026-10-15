import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../../build-artifacts.mjs';
import { loadConcepts, loadCrosslinks, parseLayout } from '../../../src/lib/artifacts/load';

const PARAMS = {
  nodeTarget: 3, maxDepth: 5,
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
      // Counts put Information theory, Chemistry and Thermodynamics in the
      // top-3 cut, so restoration pulls Physics and Natural sciences back as
      // ancestors: all five subject categories survive.
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
