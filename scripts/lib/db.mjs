import Database from 'better-sqlite3';

export const CAT_TABLE = 'CREATE TABLE cat ('
  + 'id INTEGER PRIMARY KEY, '
  + 'name TEXT NOT NULL UNIQUE, '
  // Authoritative significance, computed by MediaWiki and copied straight from
  // category.cat_pages. Counting member rows instead would undercount: it only
  // sees links that survived the meta filter.
  + 'cat_pages INTEGER NOT NULL DEFAULT 0, '
  + 'cat_subcats INTEGER NOT NULL DEFAULT 0)';

export const SCHEMA = [
  CAT_TABLE,
  'CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)',
  'CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)',
];

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const stmt of SCHEMA) db.exec(stmt);
  return db;
}

/**
 * Renumber cat.id into alphabetical name order, remapping every foreign key.
 * Insert order in the real dumps depends on how MySQL streamed them;
 * alphabetical numbering makes ids reproducible across runs.
 *
 * `parent(child, parent)` is directional and the direction is what the whole
 * category forest hangs from: child is the subcategory, parent is the category
 * it is filed under. The remap below therefore reads each old id through the
 * same mapping, column for column, and never crosses the two.
 */
export function assignStableIds(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('ALTER TABLE cat RENAME TO cat_raw');
  db.exec(CAT_TABLE);
  db.exec(`INSERT INTO cat(id, name, cat_pages, cat_subcats)
            SELECT ROW_NUMBER() OVER (ORDER BY name), name, cat_pages, cat_subcats
            FROM cat_raw`);

  // Old id to new id, used by both edge tables below.
  db.exec('CREATE TABLE id_map (old_id INTEGER PRIMARY KEY, new_id INTEGER NOT NULL)');
  db.exec(`INSERT INTO id_map(old_id, new_id)
            SELECT cat_raw.id, cat.id FROM cat_raw JOIN cat ON cat.name = cat_raw.name`);

  db.exec('ALTER TABLE parent RENAME TO parent_raw');
  db.exec('CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)');
  db.exec(`INSERT INTO parent(child, parent)
            SELECT c.new_id, p.new_id FROM parent_raw r
            JOIN id_map c ON c.old_id = r.child
            JOIN id_map p ON p.old_id = r.parent`);

  db.exec('ALTER TABLE member RENAME TO member_raw');
  db.exec('CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)');
  db.exec(`INSERT INTO member(article, cat)
            SELECT r.article, c.new_id FROM member_raw r
            JOIN id_map c ON c.old_id = r.cat`);

  db.exec('DROP TABLE cat_raw');
  db.exec('DROP TABLE parent_raw');
  db.exec('DROP TABLE member_raw');
  db.exec('DROP TABLE id_map');
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * The indexes `finalizeIndexes` must leave behind, in creation order. Exported
 * so ingest can assert they exist rather than assume it: a database with no
 * indexes still produces a correct atlas, just 12x slower to build, so nothing
 * else would ever notice.
 */
export const REQUIRED_INDEXES = [
  'idx_parent_child',
  'idx_parent_parent',
  'idx_member_cat',
  'idx_member_article',
];

export function finalizeIndexes(db) {
  for (const name of REQUIRED_INDEXES) {
    const table = name.startsWith('idx_parent') ? 'parent' : 'member';
    const column = name.replace(/^idx_(parent|member)_/, '');
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`);
  }
}