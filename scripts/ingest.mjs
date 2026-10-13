import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamInsertRows, readDumpSchema } from './lib/sql-stream.mjs';
import { normalizeCategoryName, isMaintenanceCategory } from './lib/categories.mjs';
import { openDb, assignStableIds, finalizeIndexes } from './lib/db.mjs';

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
  rawCategories: 0, afterMetaFilter: 0, keptParents: 0, keptMembers: 0,
  linkRows: 0, resolvedTargets: 0, keptTargets: 0, targetResolution: 0,
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

/** Refuse to ingest rows shaped differently from the declared schema. */
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
  // A name-keyed map rather than an id-keyed one: nothing downstream needs a
  // cat_id, because categorylinks does not reference one. The ids stored are
  // provisional; assignStableIds renumbers cat alphabetically at the end and
  // remaps every foreign key, so nothing depends on these exact numbers.
  const idByName = new Map();
  let rawCategories = 0;
  let guardedCats = false;

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
    if (!guardedCats) { guardWidth('category', v, catCols.length); guardedCats = true; }
    rawCategories++;
    const name = normalizeCategoryName(v[CAT_TITLE]);
    if (!name || isMaintenanceCategory(name)) return;
    catBatch.push([
      name, Number(v[CAT_PAGES]) || 0, Number(v[CAT_SUBCATS]) || 0,
    ]);
    if (catBatch.length >= BATCH) { insertCats(catBatch); catBatch = []; }
  });
  if (catBatch.length) insertCats(catBatch);

  INGEST_STATS.rawCategories = rawCategories;
  INGEST_STATS.afterMetaFilter = db.prepare('SELECT COUNT(*) AS n FROM cat').get().n;

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
  // Every ns-14 lt_id is kept, whether or not its category survived Pass A, and
  // DROPPED marks the ones that did not. That distinction is the whole point:
  // "the target named a category we threw away" and "the target named nothing
  // at all" are opposite failures, and only the second one means the join is
  // broken. Measured on the real dumps, 70.6% of categorylinks rows name a
  // meta-filtered category — maintenance categories are the most heavily
  // linked ones on Wikipedia — so collapsing the two would trip the guard on
  // every correct run.
  const ltIdToName = new Map();
  let guardedTargets = false;

  await streamInsertRows(paths.linktarget, (table, v) => {
    if (table !== 'linktarget') return;
    if (!guardedTargets) { guardWidth('linktarget', v, targetCols.length); guardedTargets = true; }
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
  const idByPageId = new Map();
  let guarded = false;

  await streamInsertRows(paths.page, (table, v) => {
    if (table !== 'page') return;
    // The width guard runs on the first row of any namespace. Sitting it behind
    // the namespace filter would mean a shifted dump stayed unnoticed whenever
    // the categories it lost happened to be the only affected rows.
    if (!guarded) { guardWidth('page', v, pageCols.length); guarded = true; }
    if (v[PAGE_NS] !== CATEGORY_NAMESPACE) return;
    const id = idByName.get(normalizeCategoryName(v[PAGE_TITLE]));
    if (id === undefined) return;
    idByPageId.set(Number(v[PAGE_ID]), id);
  });

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
  let guardedLinks = false;
  let linkRows = 0;
  let resolvedTargets = 0;
  let keptTargets = 0;

  await streamInsertRows(paths.categorylinks, (table, v) => {
    if (table !== 'categorylinks') return;
    if (!guardedLinks) { guardWidth('categorylinks', v, linkCols.length); guardedLinks = true; }
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

  // --- Fail loudly on catastrophic row loss ---------------------------------
  //
  // Resolving cl_target_id against cat_id instead of lt_id keeps every counter
  // looking plausible while discarding 99% of the rows, four hours in. The
  // number is logged whether or not it is acceptable, because a run that lands
  // just above the floor is the one worth looking at.
  //
  // The guard measures the join alone. Categories dropped by the meta filter
  // are reported separately rather than folded in: on the real dumps they are
  // 29% of all rows, so counting them as join failures would abort every
  // correct run and teach the operator to ignore the guard.
  const rate = linkRows > 0 ? resolvedTargets / linkRows : 0;
  INGEST_STATS.linkRows = linkRows;
  INGEST_STATS.resolvedTargets = resolvedTargets;
  INGEST_STATS.keptTargets = keptTargets;
  INGEST_STATS.targetResolution = rate;
  console.log(`cl_target_id -> lt_title resolution: ${resolvedTargets}/${linkRows} (${(rate * 100).toFixed(2)}%)`);
  if (linkRows > 0) {
    console.log(`meta filter kept ${keptTargets}/${linkRows} targets (${(100 * keptTargets / linkRows).toFixed(2)}% of links)`);
  }

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