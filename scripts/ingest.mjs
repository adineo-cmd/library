import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamInsertRows, readDumpSchema } from './lib/sql-stream.mjs';
import { normalizeCategoryName } from './lib/categories.mjs';
import { openDb, assignStableIds, finalizeIndexes, REQUIRED_INDEXES } from './lib/db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = resolve(ROOT, 'atlas-work');

// The dumps are gigabytes and are usually kept beside the repo rather than
// inside it. ATLAS_DUMP_DIR wins; otherwise use the repo if it holds the
// dumps, else the parent directory.
const DUMP_DIR = process.env.ATLAS_DUMP_DIR
  ? resolve(process.env.ATLAS_DUMP_DIR)
  : (existsSync(resolve(ROOT, 'enwiki-latest-page.sql.gz')) ? ROOT : resolve(ROOT, '..'));

export const PATHS = {
  page: resolve(DUMP_DIR, 'enwiki-latest-page.sql.gz'),
  category: resolve(DUMP_DIR, 'enwiki-latest-category.sql.gz'),
  categorylinks: resolve(DUMP_DIR, 'enwiki-latest-categorylinks.sql.gz'),
  linktarget: resolve(DUMP_DIR, 'enwiki-latest-linktarget.sql.gz'),
  db: resolve(WORK, 'atlas.db'),
};

export const INGEST_STATS = {
  rawCategories: 0, insertedCategories: 0, keptParents: 0, keptMembers: 0,
  linkRows: 0, resolvedTargets: 0, keptTargets: 0, subcatRows: 0, targetResolution: 0,
};

/**
 * Below this fraction of resolved `cl_target_id` values the four dumps do not
 * belong together, and continuing would write a plausible-looking graph with
 * most of its rows missing.
 */
export const MIN_TARGET_RESOLUTION = 0.9;

const CATEGORY_NAMESPACE = '14';
/** ltIdToName value for a category that resolved but did not survive Pass A. */
const DROPPED = -1;
const BATCH = 50_000;
const CHUNK_SIZE = 8 * 1024 * 1024;

/** Every dump the join needs. `overrides` replaces paths, for tests. */
const DUMPS = ['page', 'category', 'categorylinks', 'linktarget'];

/**
 * Assert that the four indexes `finalizeIndexes` promises are actually in
 * `sqlite_master`.
 *
 * This is not belt-and-braces. The working database was once found with no
 * indexes at all — `finalizeIndexes` had not been reached, or the file was
 * carried over from an older run — and the failure mode is invisible in every
 * counter ingest prints. `selectMemberSample` issues `WHERE cat = ? LIMIT 200`
 * once per kept category; with `idx_member_cat` missing that is ~30,000 full
 * scans of a 38.25M-row table, and a run that took 100 seconds took 20 minutes
 * instead. The build was still correct, just 12x over budget, so nothing
 * failed — it only looked like the machine got slower.
 *
 * Checking `sqlite_master` after `finalizeIndexes` rather than trusting the
 * call turns that into a loud, immediate failure at the one point where the
 * indexes are known to have just been created. Exported so the assertion can
 * be tested against a database that has genuinely lost one.
 */
export function assertIndexes(db) {
  const present = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
      .map(r => r.name),
  );
  const missing = REQUIRED_INDEXES.filter(name => !present.has(name));
  if (missing.length) {
    throw new Error(
      `ingest finished but ${missing.length} index(es) are missing from sqlite_master: `
      + `${missing.join(', ')}. Without idx_member_cat every selectMemberSample `
      + 'lookup is a full scan of the member table, which turns a 100-second '
      + 'build into a 20-minute one without failing anything.',
    );
  }
  return REQUIRED_INDEXES;
}

export function missingInputs(overrides = {}) {
  return DUMPS
    .map(key => overrides[key] ?? PATHS[key])
    .filter(path => !existsSync(path));
}

/** Position of a column, resolved by name so dump vintages do not matter. */
function column(schema, table, column) {
  const columns = schema.get(table);
  if (!columns) throw new Error(`no CREATE TABLE for \`${table}\` in the first ${CHUNK_SIZE} bytes of the dump`);
  const index = columns.indexOf(column);
  if (index === -1) {
    throw new Error(`\`${table}\` has no column \`${column}\`; dump declares ${columns.join(', ')}`);
  }
  return index;
}

/**
 * Refuse to ingest rows shaped differently from the declared schema.
 *
 * This runs on EVERY row, not just the first. A row that is one field short
 * parses without error and shifts every column after the gap, so a malformed
 * row in the middle of a table used to land as a wrong-but-plausible value —
 * a truncated `cl_target_id` became NaN and showed up only as a resolution
 * dip, but a shifted `lt_title` becomes a valid wrong category name and
 * writes a wrong graph behind entirely healthy counters. No floor added later
 * in this file can catch that. One integer comparison per row is not worth
 * trading against a multi-hour run.
 */
function guardWidth(table, row, columns) {
  if (row.length !== columns) {
    throw new Error(`\`${table}\` row has ${row.length} fields, schema declares ${columns}`);
  }
}

/**
 * Stream the four dumps into SQLite. `overrides` replaces any of PATHS, which
 * is how the tests point the whole pipeline at a fixture.
 */
export async function ingest(overrides = {}) {
  const paths = { ...PATHS, ...overrides };
  for (const key of Object.keys(INGEST_STATS)) INGEST_STATS[key] = 0;

  // Everything that can fail cheaply happens before the existing database is
  // deleted. A run that dies an hour in must not also destroy the last good
  // four-hour result.
  const missing = missingInputs(paths);
  if (missing.length) throw new Error('Missing input dumps:\n  ' + missing.join('\n  '));

  const schemas = {};
  for (const key of DUMPS) {
    schemas[key] = await readDumpSchema(paths[key], CHUNK_SIZE);
    if (!schemas[key].size) throw new Error(`No CREATE TABLE found in ${paths[key]}; dump looks wrong`);
  }

  // Resolve every column index before the old database goes, so a dump that
  // cannot be read costs nothing but the error.
  const pageSchema = schemas.page;
  const catSchema = schemas.category;
  const linksSchema = schemas.categorylinks;
  const targetSchema = schemas.linktarget;
  const pageCols = pageSchema.get('page') ?? [];
  const catCols = catSchema.get('category') ?? [];
  const linkCols = linksSchema.get('categorylinks') ?? [];
  const targetCols = targetSchema.get('linktarget') ?? [];
  const PAGE_ID = column(pageSchema, 'page', 'page_id');
  const PAGE_NS = column(pageSchema, 'page', 'page_namespace');
  const PAGE_TITLE = column(pageSchema, 'page', 'page_title');
  const CAT_TITLE = column(catSchema, 'category', 'cat_title');
  const CAT_PAGES = column(catSchema, 'category', 'cat_pages');
  const CAT_SUBCATS = column(catSchema, 'category', 'cat_subcats');
  const CL_FROM = column(linksSchema, 'categorylinks', 'cl_from');
  const CL_TYPE = column(linksSchema, 'categorylinks', 'cl_type');
  const CL_TARGET = column(linksSchema, 'categorylinks', 'cl_target_id');
  const LT_ID = column(targetSchema, 'linktarget', 'lt_id');
  const LT_NS = column(targetSchema, 'linktarget', 'lt_namespace');
  const LT_TITLE = column(targetSchema, 'linktarget', 'lt_title');

  mkdirSync(dirname(paths.db), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(paths.db + suffix)) rmSync(paths.db + suffix);
  }
  const db = openDb(paths.db);

  const insCat = db.prepare('INSERT OR IGNORE INTO cat(name,cat_pages,cat_subcats) VALUES (?,?,?)');
  const insParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
  const insMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');

  // --- Pass A: the category table, the authoritative category list. ---
  //
  // EVERY category is written here, maintenance scaffolding included. This used
  // to drop `isMaintenanceCategory(name)` names as they arrived, and that one
  // line was an architectural defect rather than a shortcut:
  //
  //   * it ran before the graph existed, so the meta filter had no graph to
  //     reason about and could only ever remove rows;
  //   * `idByPageId` (pass B) only ever held surviving categories, and the
  //     parent edge in pass C is written only when the child resolves there,
  //     so a category whose parent was filtered away got NO parent edge at
  //     all. Measured on the real dumps: 1,061,927 of 2,481,394 categories
  //     (42.8%) had no parent row, and 4,000 sampled atlas roots had none
  //     either. The filter was silently amputating 43% of the hierarchy and
  //     promoting the stumps to roots, which is where 18.1% maintenance roots
  //     came from;
  //   * it also made small fields unreachable. Pass 5 restores the ancestors of
  //     kept nodes, but it can only walk edges that exist, so a broad field
  //     whose ancestry touched a filtered node could never be restored and was
  //     cut for being small (Art 38 pages, Religion 32, Music 46 — all below
  //     the ~304-page cut).
  //
  // The meta filter is now a graph-time operation: prune.mjs marks nodes and
  // splices each survivor up to its nearest surviving ancestor, so removing a
  // node can never orphan a child. `isMaintenanceCategory` stays the single
  // source of truth for what counts as maintenance; only *when* it runs moved.
  //
  // The only name test left here is emptiness: a category whose normalised name
  // is blank has no identity to key `cat.name` on, and `name` is UNIQUE.
  //
  // A name-keyed map rather than an id-keyed one: nothing downstream needs a
  // cat_id, because categorylinks does not reference one. The ids stored are
  // provisional; assignStableIds renumbers cat alphabetically at the end and
  // remaps every foreign key, so nothing depends on these exact numbers.
  const idByName = new Map();
  let rawCategories = 0;

  const insertCats = db.transaction((batch) => {
    for (const [name, pages, subcats] of batch) {
      const info = insCat.run(name, pages, subcats);
      // A name that collides after normalisation is ignored; the map may not
      // claim an id for a row that was never created.
      if (info.changes === 1) idByName.set(name, info.lastInsertRowid);
    }
  });

  let catBatch = [];
  await streamInsertRows(paths.category, (table, v) => {
    if (table !== 'category') return;
    guardWidth('category', v, catCols.length);
    rawCategories++;
    const name = normalizeCategoryName(v[CAT_TITLE]);
    if (!name) return;
    catBatch.push([
      name, Number(v[CAT_PAGES]) || 0, Number(v[CAT_SUBCATS]) || 0,
    ]);
    if (catBatch.length >= BATCH) { insertCats(catBatch); catBatch = []; }
  });
  if (catBatch.length) insertCats(catBatch);

  INGEST_STATS.rawCategories = rawCategories;
  INGEST_STATS.insertedCategories = db.prepare('SELECT COUNT(*) AS n FROM cat').get().n;

  // --- Pass A2: linktarget, which is what categorylinks actually points at ---
  //
  // categorylinks carries no title and no cat_id. Its cl_target_id is a
  // linktarget.lt_id — an id space of its own that collides with neither
  // page_id nor cat_id, so the wrong join is undetectable from the counters and
  // simply throws away almost every row.
  //
  // Only namespace 14 is a category page. Every other row names an article,
  // file, template or special page and must be ignored even when its title
  // happens to read exactly like a category.
  //
  // lt_title is underscored exactly as cat_title is and page titles are not, so
  // both sides are normalised before they meet.
  //
  // Every ns-14 lt_id is kept, and DROPPED now marks only the ones that name a
  // category this dump does not have at all — a linktarget row pointing past
  // the end of the category table, or a title that normalises onto nothing.
  // "The target named a category we are not using" is no longer a state that
  // can occur here, because nothing is discarded at this point: the meta filter
  // runs later, in prune.mjs, against the finished graph. DROPPED stays
  // because that distinction is still the whole point — "the target named a
  // category the dump lacks" and "the target named nothing at all" are
  // opposite failures, and only the second one means the join is broken.
  const ltIdToName = new Map();

  await streamInsertRows(paths.linktarget, (table, v) => {
    if (table !== 'linktarget') return;
    guardWidth('linktarget', v, targetCols.length);
    if (v[LT_NS] !== CATEGORY_NAMESPACE) return;
    const id = idByName.get(normalizeCategoryName(v[LT_TITLE]));
    ltIdToName.set(Number(v[LT_ID]), id === undefined ? DROPPED : id);
  });
  if (ltIdToName.size === 0) {
    throw new Error(
      'linktarget produced zero ns-14 targets. The linktarget dump must come from the '
      + 'SAME snapshot date as categorylinks; across snapshots lt_id values do not '
      + 'join and almost every categorylinks row is discarded.',
    );
  }

  // --- Pass B: the page table, for the other half of a category edge. ---
  //
  // categorylinks.cl_from is a page_id, and only a category page can be the
  // child of a subcategory edge. Titles are matched through the category
  // table's names because the two dumps disagree on underscores: page titles
  // carry none, cat_title carries them.
  //
  // Every ns-14 page lands in `idByPageId`, with no exceptions to carve out.
  // That is what makes the graph complete: pass C writes a parent edge
  // whenever the child resolves here, so a page held back here loses its
  // parent row and is promoted to a root forever. `idByName` now holds the
  // whole category table (pass A inserts everything), so the only pages this
  // drops are ns-14 pages whose title is not a category at all.
  const idByPageId = new Map();

  await streamInsertRows(paths.page, (table, v) => {
    if (table !== 'page') return;
    // Ahead of the namespace filter, and on every row: sitting it behind either
    // would mean a shifted dump stayed unnoticed whenever the rows it affected
    // happened to be ones this pass filters out anyway.
    guardWidth('page', v, pageCols.length);
    if (v[PAGE_NS] !== CATEGORY_NAMESPACE) return;
    const id = idByName.get(normalizeCategoryName(v[PAGE_TITLE]));
    if (id === undefined) return;
    idByPageId.set(Number(v[PAGE_ID]), id);
  });

  // Last read of idByName. Every closure that captures it (insertCats in pass
  // A, the two stream callbacks above) is reachable for the rest of this
  // function, so the map is context-resident even though it is dead, and pass C
  // allocates the two largest structures in the run on top of it. Clearing is
  // what actually returns the pages to the OS; nulling the binding would not,
  // because insertCats would still hold the map.
  idByName.clear();

  // --- Pass C: categorylinks, which names its target only by lt_id. ---
  //
  // `member.article` is the cl_from page id as a string: article identity is
  // only ever used to count co-membership between categories, never displayed,
  // so joining `page` for titles would cost another pass for no benefit.
  const flushMembers = db.transaction((rows) => {
    for (const [article, catId] of rows) insMember.run(article, catId);
  });
  const flushParents = db.transaction((rows) => {
    for (const [child, parentId] of rows) insParent.run(child, parentId);
  });

  const memberBatch = [];
  const parentBatch = [];
  let linkRows = 0;
  let resolvedTargets = 0;
  let keptTargets = 0;
  let subcatRows = 0;

  await streamInsertRows(paths.categorylinks, (table, v) => {
    if (table !== 'categorylinks') return;
    guardWidth('categorylinks', v, linkCols.length);
    linkRows++;
    const target = ltIdToName.get(Number(v[CL_TARGET]));
    // Absent from the map: no ns-14 linktarget row carries this id at all.
    // That is the broken-join signature the guard exists to catch.
    if (target === undefined) return;
    resolvedTargets++;
    if (target === DROPPED) return;
    keptTargets++;
    const type = v[CL_TYPE];
    // 'subcat' is this dump's spelling of a category-page link; older dumps
    // write 'category'. Everything else files an article under a category.
    if (type === 'subcat' || type === 'category') {
      subcatRows++;
      const child = idByPageId.get(Number(v[CL_FROM]));
      // A category cannot be its own parent, and a self edge would close a
      // one-node cycle in the tree built downstream.
      if (child === undefined || child === target) return;
      parentBatch.push([child, target]);
      if (parentBatch.length >= BATCH) { flushParents(parentBatch.splice(0)); }
      return;
    }
    memberBatch.push([v[CL_FROM], target]);
    if (memberBatch.length >= BATCH) { flushMembers(memberBatch.splice(0)); }
  });
  if (memberBatch.length) flushMembers(memberBatch);
  if (parentBatch.length) flushParents(parentBatch);

  assignStableIds(db);
  INGEST_STATS.keptParents = db.prepare('SELECT COUNT(*) AS n FROM parent').get().n;
  INGEST_STATS.keptMembers = db.prepare('SELECT COUNT(*) AS n FROM member').get().n;

  finalizeIndexes(db);
  assertIndexes(db);

  // --- Fail loudly on catastrophic row loss ---------------------------------
  //
  // Resolving cl_target_id against cat_id instead of lt_id keeps every counter
  // looking plausible while discarding 99% of the rows, four hours in. The
  // number is logged whether or not it is acceptable, because a run that lands
  // just above the floor is the one worth looking at.
  //
  // The guard measures the join alone. Nothing about the meta filter enters
  // the denominator any more, because nothing is filtered at this point: every
  // resolvable target is kept, and `keptTargets` is now `resolvedTargets` less
  // the handful of links pointing at categories the dumps do not carry. An
  // earlier version folded meta-filtered targets into the rate and needed a
  // separate counter to stay honest; that hazard is gone with the filter.
  //
  // Two floors, not one. The rate above only proves the join worked; it says
  // nothing about whether either output is non-empty, and a run can clear it
  // while writing ~150M member rows and no hierarchy whatsoever. keptMembers and
  // keptParents are each checked for that.
  const rate = linkRows > 0 ? resolvedTargets / linkRows : 0;
  INGEST_STATS.linkRows = linkRows;
  INGEST_STATS.resolvedTargets = resolvedTargets;
  INGEST_STATS.keptTargets = keptTargets;
  INGEST_STATS.subcatRows = subcatRows;
  INGEST_STATS.targetResolution = rate;
  console.log(`cl_target_id -> lt_title resolution: ${resolvedTargets}/${linkRows} (${(rate * 100).toFixed(2)}%)`);
  if (linkRows > 0) {
    console.log(`targets written: ${keptTargets}/${linkRows} (${(100 * keptTargets / linkRows).toFixed(2)}% of links)`);
  }
  console.log(`categories written: ${INGEST_STATS.insertedCategories} of ${rawCategories} rows read (meta filter runs later, in prune)`);
  // Printed unconditionally: with keptParents at 0 this is the line that tells
  // an operator whether the dump had no 'subcat' rows at all (a dead branch)
  // or had them and something discarded every one (a real bug). The two are
  // otherwise indistinguishable from the keptParents counter alone.
  console.log(`subcat rows: ${subcatRows} (${INGEST_STATS.keptParents} parent edges written)`);

  db.close();

  if (rate < MIN_TARGET_RESOLUTION) {
    throw new Error(
      `Only ${(rate * 100).toFixed(2)}% of categorylinks rows resolved to a category `
      + `(< ${(MIN_TARGET_RESOLUTION * 100).toFixed(0)}% required). The four dumps must `
      + 'come from ONE dated directory, e.g. https://dumps.wikimedia.org/enwiki/20260801/. '
      + 'A linktarget dump from a different snapshot date than categorylinks is the usual cause.',
    );
  }
  if (INGEST_STATS.keptMembers === 0) {
    throw new Error('ingest produced zero member rows');
  }
  // A run can resolve every target and still yield no hierarchy at all: the
  // parent edges come from cl_type='subcat' rows only, so ~150M member rows
  // with zero parents is a graph with no tree in it, and both counters above
  // would look perfectly healthy.
  if (INGEST_STATS.keptParents === 0) {
    throw new Error(
      `ingest produced zero parent edges from ${subcatRows} subcat rows, although `
      + `${keptTargets} targets resolved. On the real dumps 'subcat' is 2.02% of categorylinks, `
      + 'so a zero here means the cl_type branch is dead or the page->category join in Pass B '
      + 'is wrong, not that Wikipedia has no category hierarchy.',
    );
  }
  return INGEST_STATS;
}

// Compared as resolved paths: import.meta.url percent-encodes, so a repo
// directory containing a space would otherwise never reach this block.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = missingInputs();
  if (missing.length) {
    console.error('Missing input dumps:');
    missing.forEach(p => console.error('  ' + p));
    process.exit(1);
  }
  ingest()
    .then(s => { console.log('ingest complete'); console.table(s); })
    .catch(err => { console.error(err); process.exit(1); });
}