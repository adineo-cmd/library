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
  db: resolve(WORK, 'atlas.db'),
};

export const INGEST_STATS = {
  rawCategories: 0, afterMetaFilter: 0, keptParents: 0, keptMembers: 0,
};

const CATEGORY_NAMESPACE = '14';
const BATCH = 50_000;
const CHUNK_SIZE = 8 * 1024 * 1024;

export function missingInputs() {
  return [PATHS.page, PATHS.category, PATHS.categorylinks].filter(p => !existsSync(p));
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

export async function ingest() {
  mkdirSync(WORK, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(PATHS.db + suffix)) rmSync(PATHS.db + suffix);
  }
  const db = openDb(PATHS.db);

  const pageSchema = await readDumpSchema(PATHS.page, CHUNK_SIZE);
  const catSchema = await readDumpSchema(PATHS.category, CHUNK_SIZE);
  const linksSchema = await readDumpSchema(PATHS.categorylinks, CHUNK_SIZE);
  const pageCols = pageSchema.get('page') ?? [];
  const catCols = catSchema.get('category') ?? [];
  const linkCols = linksSchema.get('categorylinks') ?? [];
  const PAGE_ID = column(pageSchema, 'page', 'page_id');
  const PAGE_NS = column(pageSchema, 'page', 'page_namespace');
  const PAGE_TITLE = column(pageSchema, 'page', 'page_title');
  const CAT_ID = column(catSchema, 'category', 'cat_id');
  const CAT_TITLE = column(catSchema, 'category', 'cat_title');
  const CAT_PAGES = column(catSchema, 'category', 'cat_pages');
  const CAT_SUBCATS = column(catSchema, 'category', 'cat_subcats');
  const CL_FROM = column(linksSchema, 'categorylinks', 'cl_from');
  const CL_TYPE = column(linksSchema, 'categorylinks', 'cl_type');
  const CL_TARGET = column(linksSchema, 'categorylinks', 'cl_target_id');

  const insCat = db.prepare('INSERT OR IGNORE INTO cat(name,cat_pages,cat_subcats) VALUES (?,?,?)');
  const insParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
  const insMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');

  // --- Pass A: the category table, the authoritative category list. ---
  //
  // Two maps keyed on numbers rather than strings: page ids and cat ids are
  // small integers, and a numeric Map is both far smaller and faster to probe
  // than one keyed on strings. The ids stored are provisional; assignStableIds
  // renumbers cat alphabetically at the end and remaps every foreign key, so
  // nothing downstream depends on these exact numbers.
  //
  // No cat_id -> cat_title map is kept: the title goes straight into SQLite
  // and only the resulting row id is retained.
  const idByCatId = new Map();
  const idByName = new Map();
  let rawCategories = 0;
  let guardedCats = false;

  const insertCats = db.transaction((batch) => {
    for (const [catId, name, pages, subcats] of batch) {
      const info = insCat.run(name, pages, subcats);
      // A name that collides after normalisation is ignored; neither map may
      // claim an id for a row that was never created.
      if (info.changes === 1) {
        idByCatId.set(catId, info.lastInsertRowid);
        idByName.set(name, info.lastInsertRowid);
      }
    }
  });

  let catBatch = [];
  await streamInsertRows(PATHS.category, (table, v) => {
    if (table !== 'category') return;
    if (!guardedCats) { guardWidth('category', v, catCols.length); guardedCats = true; }
    rawCategories++;
    const name = normalizeCategoryName(v[CAT_TITLE]);
    if (!name || isMaintenanceCategory(name)) return;
    catBatch.push([
      Number(v[CAT_ID]), name, Number(v[CAT_PAGES]) || 0, Number(v[CAT_SUBCATS]) || 0,
    ]);
    if (catBatch.length >= BATCH) { insertCats(catBatch); catBatch = []; }
  });
  if (catBatch.length) insertCats(catBatch);

  INGEST_STATS.rawCategories = rawCategories;
  INGEST_STATS.afterMetaFilter = db.prepare('SELECT COUNT(*) AS n FROM cat').get().n;

  // --- Pass B: the page table, for the other half of a category edge. ---
  //
  // categorylinks.cl_from is a page_id, and only a category page can be the
  // child of a subcategory edge. Titles are matched through the category
  // table's names because the two dumps disagree on underscores: page titles
  // carry none, cat_title carries them.
  const idByPageId = new Map();
  let guarded = false;

  await streamInsertRows(PATHS.page, (table, v) => {
    if (table !== 'page' || v[PAGE_NS] !== CATEGORY_NAMESPACE) return;
    if (!guarded) { guardWidth('page', v, pageCols.length); guarded = true; }
    const id = idByName.get(normalizeCategoryName(v[PAGE_TITLE]));
    if (id === undefined) return;
    idByPageId.set(Number(v[PAGE_ID]), id);
  });

  // --- Pass C: categorylinks, which names its target only by cat_id. ---
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

  await streamInsertRows(PATHS.categorylinks, (table, v) => {
    if (table !== 'categorylinks') return;
    if (!guardedLinks) { guardWidth('categorylinks', v, linkCols.length); guardedLinks = true; }
    const target = idByCatId.get(Number(v[CL_TARGET]));
    if (target === undefined) return;
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
  db.close();
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