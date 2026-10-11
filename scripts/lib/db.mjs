import Database from 'better-sqlite3';

export const SCHEMA = [
  'CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
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
  db.exec('CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  db.exec('INSERT INTO cat(id, name) SELECT ROW_NUMBER() OVER (ORDER BY name), name FROM cat_raw');

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

export function finalizeIndexes(db) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_parent_child ON parent(child)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_parent_parent ON parent(parent)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_cat ON member(cat)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_article ON member(article)');
}