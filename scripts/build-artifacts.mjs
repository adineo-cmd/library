import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  markMetaRemoved, spliceRemovedNodes, compactSurvivors, selectPrimaryParents,
  breakCycles, capDepth, rankAndCut, assertAcyclic, assignDepth, reachWeightedPages,
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
  // Hops up the parent graph when measuring a category's reach weight. Six was
  // chosen by measurement: all 30 broad fields land inside the 30k cut (ranks
  // 137-13,776) and the whole pass runs in ~6s. See `reachWeightedPages`.
  reachHopLimit: 6,
};

const VERSION = '1';

/**
 * Run the five pruning passes over the SQLite graph and emit dense-indexed
 * nodes. Returns a map from SQLite cat.id to dense node index so cross-link
 * edges can be remapped into the same space.
 *
 * The graph on disk is COMPLETE: ingest writes every ns-14 category and every
 * subcategory edge between them, and the meta filter runs here, at pass 1,
 * where it can see that graph. That ordering is the whole point — a filter
 * applied at insert time could only delete rows, and deleting the row of a
 * category that other categories hang from promotes those children to roots
 * instead of moving them up one level.
 */
export function pruneToNodes(db, params) {
  // The full category table, streamed rather than materialised. `.all()` on
  // 2.65M rows would hold every row object, every name and the ordered copy all
  // at once; iterating lets each row be collected into three flat structures
  // and dropped. `ORDER BY name` is kept so node order here matches the order
  // `rankAndCut` breaks ties in, whatever the ids in the table happen to be.
  const allNames = [];
  const allIds = [];
  const allPages = [];
  const dbIndex = new Map();
  let rawCategories = 0;
  for (const r of db.prepare('SELECT id, name, cat_pages FROM cat ORDER BY name').iterate()) {
    dbIndex.set(r.id, rawCategories);
    allNames.push(r.name);
    allIds.push(r.id);
    allPages.push(Number(r.cat_pages) || 0);
    rawCategories++;
  }
  const nodeCount = rawCategories;

  // --- Pass 1: the meta filter, marked against the finished graph ------------
  const removed = markMetaRemoved(allNames);

  const parentsByChild = Array.from({ length: nodeCount }, () => []);
  for (const e of db.prepare('SELECT child, parent FROM parent').all()) {
    const child = dbIndex.get(e.child);
    const parent = dbIndex.get(e.parent);
    if (child === undefined || parent === undefined) continue;
    parentsByChild[child].push(parent);
  }

  // cat_pages is MediaWiki's authoritative article count (see Task 3). Counting
  // member rows instead would be wrong twice over: it undercounts, and it is
  // now measuring over the unfiltered member table.
  //
  // Pass 2. Runs on the FULL graph, maintenance scaffolding included, so the
  // subtree sizes that decide each node's primary parent are the sizes a node
  // really has on Wikipedia. The splice that follows is what removes the
  // maintenance nodes; by then each surviving node has exactly one parent and
  // the upward walk is unambiguous.
  const { primary, demoted } = selectPrimaryParents(parentsByChild, nodeCount);
  const parentOf = breakCycles(primary, demoted, nodeCount);

  // Pass 1's second half: every survivor is re-parented onto its nearest
  // surviving ancestor, so a removed node hands its children to its own parent
  // instead of stranding them. Nothing below this line ever sees a removed node
  // as a parent.
  const spliced = spliceRemovedNodes(parentOf, removed, nodeCount);

  // The rank weight, computed on the FULL graph while `parentsByChild` still
  // holds every parent edge. Pass 2 is about to keep one parent per node and
  // throw the rest away, and 58.7% of nodes are multi-parented, so the multi-
  // parent structure has to be measured before it is discarded — not after.
  const reachOnFull = reachWeightedPages(
    parentsByChild, allPages, nodeCount, params.reachHopLimit ?? 6,
  );

  // Compact to survivors and release the full-graph structures before the
  // remaining passes, which then run at exactly the size they used to.
  const { remap, original, names, count: afterMetaFilter } = compactSurvivors(allNames, removed);
  const survivorParent = new Int32Array(afterMetaFilter);
  const survivorPages = new Int32Array(afterMetaFilter);
  const survivorReach = new Float64Array(afterMetaFilter);
  for (let i = 0; i < nodeCount; i++) {
    const s = remap[i];
    if (s < 0) continue;
    const parent = spliced[i];
    // A survivor's parent is either another survivor or -1 by construction;
    // anything else means the splice handed back a node it removed.
    survivorParent[s] = parent === -1 ? -1 : remap[parent];
    if (parent !== -1 && survivorParent[s] < 0) {
      throw new Error(`node ${names[s]} was spliced onto removed node ${parent}`);
    }
    survivorPages[s] = allPages[i];
    survivorReach[s] = reachOnFull[i];
  }
  parentsByChild.length = 0;
  dbIndex.clear();

  // Pass 3
  const capped = capDepth(survivorParent, afterMetaFilter, params.maxDepth);

  // Passes 4 and 5
  const depthBeforeCut = assignDepth(capped.parentOf, afterMetaFilter);
  const { kept, restoredCount } = rankAndCut(
    capped.parentOf, depthBeforeCut, survivorPages, afterMetaFilter, params.nodeTarget,
    survivorReach,
  );

  const localToDense = new Int32Array(afterMetaFilter).fill(-1);
  const sqliteToDense = new Map();
  const order = [];
  for (let i = 0; i < afterMetaFilter; i++) {
    if (!kept[i]) continue;
    localToDense[i] = order.length;
    sqliteToDense.set(allIds[original[i]], order.length);
    order.push(i);
  }

  // `aliases` is intentionally always empty in v1. Redirect-derived alternates
  // need enwiki-latest-redirect.sql.gz, which is not part of the input data.
  // An empty array means "not computed yet" and consumers must not read it as
  // "this concept has no alternates".
  const nodes = order.map(i => ({
    id: slugify(names[i]),
    name: names[i],
    parent: capped.parentOf[i] === -1 ? -1 : (localToDense[capped.parentOf[i]] ?? -1),
    depth: depthBeforeCut[i],
    articleCount: survivorPages[i],
    aliases: [],
  }));

  assertAcyclic(Int32Array.from(nodes.map(n => n.parent)), nodes.length);

  return {
    nodes,
    sqliteToDense,
    counts: {
      rawCategories,
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
  const stage = (label) => {
    const started = Date.now();
    return (done) => console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${label}${done ? ` — ${done}` : ''}`);
  };

  let tick = stage('load graph');
  const { nodes, sqliteToDense, counts } = pruneToNodes(db, finalParams);
  tick(`${counts.rawCategories.toLocaleString()} categories -> ${counts.finalNodes.toLocaleString()} nodes`);
  db.close();

  tick = stage('cross-links');
  // Cross-links are computed in SQLite cat.id space; remap into dense space.
  // Edges whose endpoint was pruned are dropped here, at build time, and
  // counted. They must never reach the artifact for a user to click.
  //
  // `keptIds` restricts the candidate set to the nodes the rank cut actually
  // kept. Without it the sample would cover all ~2.4M surviving categories
  // (~470M member rows) to produce edges that are then dropped at remap
  // time — the kept set is a strict superset of what can appear in the
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
  edges.sort((x, y) => (x.a - y.a) || (x.b - y.b));
  tick(`${edges.length.toLocaleString()} edges${dangling ? ` (${dangling} dangling dropped)` : ''}`);
  if (dangling) console.warn(`  ${dangling} cross-link edge(s) dropped: endpoint was pruned`);

  const concepts = buildConceptsFile(nodes, null, version);
  const crosslinks = buildCrosslinksFile(edges);

  // Skip the force layout when the node set is byte-identical to last run.
  const hash = layoutInputHash(nodes);
  const hashPath = resolve(outDir, 'layout.hash');
  const binPath = resolve(outDir, 'layout.bin');
  tick = stage('force layout');
  let layoutBuffer;
  if (existsSync(hashPath) && existsSync(binPath)
      && readFileSync(hashPath, 'utf8').trim() === hash) {
    const cached = readFileSync(binPath);
    layoutBuffer = cached.buffer.slice(
      cached.byteOffset, cached.byteOffset + cached.byteLength,
    );
    tick('reused cached positions');
  } else {
    layoutBuffer = packLayout(computePositions(nodes), nodes, edges);
    writeFileSync(hashPath, hash);
    tick('computed');
  }

  tick = stage('write artifacts');
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
  tick(Object.keys(files).join(', '));

  return { files, concepts, crosslinks, layoutBuffer, meta, nodes };
}

// Compared as resolved paths: import.meta.url percent-encodes, so a repo
// path containing a space silently disables the entrypoint and the script
// exits 0 having written nothing.
//
// Output goes to public/data/artifacts, not src/data/artifacts: Astro serves
// and deploys everything under public/ verbatim, and src/ is invisible to the
// site. Writing there instead meant every fetch of /data/artifacts/*.json 404s
// and the pages hydrate into an error state. `npm run build` copies the
// directory into dist/ with no extra step.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAll({ outDir: resolve(ROOT, 'public/data/artifacts'), dbPath: resolve(ROOT, 'atlas-work/atlas.db') })
    .then(({ meta, files }) => {
      console.log('artifacts written');
      console.table(meta.counts);
      console.log('files:', Object.keys(files).join(', '));
    })
    .catch(err => { console.error(err); process.exit(1); });
}
