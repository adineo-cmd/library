import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  applyMetaFilter, selectPrimaryParents, breakCycles, capDepth,
  rankAndCut, assertAcyclic, assignDepth,
} from './lib/prune.mjs';
import { MAINTENANCE_PATTERNS } from './lib/categories.mjs';
import { buildConceptsFile, buildCrosslinksFile, buildMeta } from './lib/emit.mjs';
import { slugify } from './lib/slug.mjs';
import { crosslink } from './crosslink.mjs';
import { computePositions, packLayout, layoutInputHash } from './layout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PARAMS = {
  nodeTarget: 30_000,
  maxDepth: 5,
  crosslinkMinArticleCount: 10,
  crosslinkMinShared: 3,
  crosslinkTopK: 20,
  crosslinkGlobalCap: 400_000,
  crosslinkMemberSample: 200,
  metaFilterPatterns: MAINTENANCE_PATTERNS,
};

const VERSION = '1';

/**
 * Run the five pruning passes over the SQLite graph and emit dense-indexed
 * nodes. Returns a map from SQLite cat.id to dense node index so cross-link
 * edges can be remapped into the same space.
 */
export function pruneToNodes(db, params) {
  const rows = db.prepare('SELECT id, name FROM cat ORDER BY name').all();
  const keptNames = new Set(applyMetaFilter(rows.map(r => r.name)));

  const dbIndex = new Map();
  const names = [];
  const ids = [];
  rows.forEach(r => {
    if (!keptNames.has(r.name)) return;
    dbIndex.set(r.id, dbIndex.size);
    names.push(r.name);
    ids.push(r.id);
  });
  const nodeCount = dbIndex.size;
  const afterMetaFilter = nodeCount;

  const parentsByChild = Array.from({ length: nodeCount }, () => []);
  for (const e of db.prepare('SELECT child, parent FROM parent').all()) {
    const child = dbIndex.get(e.child);
    const parent = dbIndex.get(e.parent);
    if (child === undefined || parent === undefined) continue;
    parentsByChild[child].push(parent);
  }

  // cat_pages is MediaWiki's authoritative article count (see Task 3). Counting
  // member rows undercounts badly because member only holds meta-filtered rows.
  const articleCount = new Int32Array(nodeCount);
  for (const r of db.prepare('SELECT id, cat_pages FROM cat').all()) {
    const i = dbIndex.get(r.id);
    if (i !== undefined) articleCount[i] = r.cat_pages;
  }

  // Pass 2
  const { primary, demoted } = selectPrimaryParents(parentsByChild, nodeCount);
  const parentOf = breakCycles(primary, demoted, nodeCount);

  // Pass 3
  const capped = capDepth(parentOf, nodeCount, params.maxDepth);

  // Passes 4 and 5
  const depthBeforeCut = assignDepth(capped.parentOf, nodeCount);
  const { kept, restoredCount } = rankAndCut(
    capped.parentOf, depthBeforeCut, articleCount, nodeCount, params.nodeTarget,
  );

  const remap = new Int32Array(nodeCount).fill(-1);
  const sqliteToDense = new Map();
  const order = [];
  for (let i = 0; i < nodeCount; i++) {
    if (!kept[i]) continue;
    remap[i] = order.length;
    sqliteToDense.set(ids[i], order.length);
    order.push(i);
  }

  // `aliases` is intentionally always empty in v1. Redirect-derived alternates
  // need enwiki-latest-redirect.sql.gz, which is not part of the input data.
  // An empty array means "not computed yet" and consumers must not read it as
  // "this concept has no alternates".
  const nodes = order.map(i => ({
    id: slugify(names[i]),
    name: names[i],
    parent: capped.parentOf[i] === -1 ? -1 : (remap[capped.parentOf[i]] ?? -1),
    depth: depthBeforeCut[i],
    articleCount: articleCount[i],
    aliases: [],
  }));

  assertAcyclic(Int32Array.from(nodes.map(n => n.parent)), nodes.length);

  return {
    nodes,
    sqliteToDense,
    counts: {
      rawCategories: rows.length,
      afterMetaFilter,
      afterDepthCap: capped.removedCount,
      finalNodes: nodes.length,
      restoredAncestors: restoredCount,
    },
  };
}

export async function buildAll({
  outDir,
  dbPath,
  buildDb,
  params = DEFAULT_PARAMS,
  version = VERSION,
  generatedAt = new Date().toISOString(),
} = {}) {
  const finalParams = { ...DEFAULT_PARAMS, ...params };
  mkdirSync(outDir, { recursive: true });

  if (buildDb) await buildDb();
  else if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath}. Place enwiki-latest-page.sql.gz and ` +
      'enwiki-latest-categorylinks.sql.gz in the repo root, then run: npm run ingest',
    );
  }

  const db = new Database(dbPath, { readonly: true });
  const { nodes, sqliteToDense, counts } = pruneToNodes(db, finalParams);
  db.close();

  // Cross-links are computed in SQLite cat.id space; remap into dense space.
  // Edges whose endpoint was pruned are dropped here, at build time, and
  // counted. They must never reach the artifact for a user to click.
  //
  // `keptIds` restricts the candidate set to the nodes the rank cut actually
  // kept. Without it the sample would cover all ~2.35M post-filter
  // categories (~470M member rows) to produce edges that are then dropped at
  // remap time — the kept set is a strict superset of what can appear in the
  // artifact, so nothing reachable is lost.
  const edges = [];
  const seen = new Set();
  let dangling = 0;
  for (const e of crosslink(dbPath, { ...finalParams, keptIds: [...sqliteToDense.keys()] })) {
    const a = sqliteToDense.get(e.a);
    const b = sqliteToDense.get(e.b);
    if (a === undefined || b === undefined || a === b) { dangling++; continue; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}:${hi}`;
    if (seen.has(key)) { dangling++; continue; }
    seen.add(key);
    edges.push({ a: lo, b: hi, shared: e.shared });
  }
  edges.sort((x, y) => (x.a - x.a) || (x.b - y.b));
  if (dangling) console.warn(`  ${dangling} cross-link edge(s) dropped: endpoint was pruned`);

  const concepts = buildConceptsFile(nodes, null, version);
  const crosslinks = buildCrosslinksFile(edges);

  // Skip the force layout when the node set is byte-identical to last run.
  const hash = layoutInputHash(nodes);
  const hashPath = resolve(outDir, 'layout.hash');
  const binPath = resolve(outDir, 'layout.bin');
  let layoutBuffer;
  if (existsSync(hashPath) && existsSync(binPath)
      && readFileSync(hashPath, 'utf8').trim() === hash) {
    const cached = readFileSync(binPath);
    layoutBuffer = cached.buffer.slice(
      cached.byteOffset, cached.byteOffset + cached.byteLength,
    );
    console.log('  layout.bin unchanged, reusing cached positions');
  } else {
    layoutBuffer = packLayout(computePositions(nodes), nodes, edges);
    writeFileSync(hashPath, hash);
  }

  const meta = buildMeta(
    { ...counts, crosslinks: edges.length, danglingCrosslinks: dangling },
    finalParams, null, version, generatedAt,
  );

  const files = {};
  const write = (name, data) => { writeFileSync(resolve(outDir, name), data); files[name] = true; };
  write('concepts.json', JSON.stringify(concepts));
  write('crosslinks.json', JSON.stringify(crosslinks));
  write('layout.bin', Buffer.from(layoutBuffer));
  write('meta.json', JSON.stringify(meta, null, 2));

  return { files, concepts, crosslinks, layoutBuffer, meta, nodes };
}

// Compared as resolved paths: import.meta.url percent-encodes, so a repo
// path containing a space silently disables the entrypoint and the script
// exits 0 having written nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAll({ outDir: resolve(ROOT, 'src/data/artifacts'), dbPath: resolve(ROOT, 'atlas-work/atlas.db') })
    .then(({ meta, files }) => {
      console.log('artifacts written');
      console.table(meta.counts);
      console.log('files:', Object.keys(files).join(', '));
    })
    .catch(err => { console.error(err); process.exit(1); });
}
