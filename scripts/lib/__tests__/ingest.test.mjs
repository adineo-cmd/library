import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ingest, missingInputs, assertIndexes, PATHS, INGEST_STATS } from '../../ingest.mjs';
import { finalizeIndexes, REQUIRED_INDEXES } from '../db.mjs';

const FIXTURE_SQL = readFileSync(new URL('../../fixtures/mini-dump.sql', import.meta.url), 'utf8');

function gz(sql) {
  const path = join(mkdtempSync(join(tmpdir(), 'atlas-ingest-')), 'dump.sql.gz');
  writeFileSync(path, gzipSync(Buffer.from(sql, 'utf8')));
  return path;
}

function scratch(name = 'atlas.db') {
  return join(mkdtempSync(join(tmpdir(), 'atlas-db-')), name);
}

/** Every dump points at one gzipped fixture; the database goes to scratch. */
function fixturePaths(overrides = {}) {
  const dump = gz(FIXTURE_SQL);
  return {
    page: dump, category: dump, categorylinks: dump, linktarget: dump,
    db: scratch(), ...overrides,
  };
}

/** Swap one INSERT block of the fixture for hand-written rows. */
function withRows(table, rows) {
  return FIXTURE_SQL.replace(
    new RegExp(`INSERT INTO \\\`${table}\\\` VALUES[\\s\\S]*?;`),
    `INSERT INTO \`${table}\` VALUES\n${rows.join(',\n')};`,
  );
}

function rows(dbPath, sql) {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

const PARENTS = `SELECT c.name AS child, p.name AS parent FROM parent e
                 JOIN cat c ON c.id = e.child JOIN cat p ON p.id = e.parent
                 ORDER BY child`;
const MEMBERS = `SELECT m.article, c.name FROM member m JOIN cat c ON c.id = m.cat
                 ORDER BY m.article, c.name`;
const CATS = 'SELECT name, cat_pages, cat_subcats FROM cat ORDER BY name';
const MEMBER_COUNTS = `SELECT c.name, COUNT(*) AS n FROM member m
                       JOIN cat c ON c.id = m.cat GROUP BY c.name ORDER BY c.name`;

describe('ingest', () => {
  it('names every category by joining cl_target_id -> lt_id -> lt_title', async () => {
    // categorylinks carries no title and no cat_id. If the target were not
    // resolved through linktarget this is the assertion that would break: the
    // parent edges and the member categories are named purely by lt_title.
    const paths = fixturePaths();
    const stats = await ingest(paths);

    expect(rows(paths.db, PARENTS)).toEqual([
      { child: 'Information theory', parent: 'Physical sciences' },
      { child: 'Thermodynamics', parent: 'Physical sciences' },
    ]);
    expect(rows(paths.db, MEMBERS)).toEqual([
      { article: '1', name: 'Information theory' },
      { article: '1', name: 'Physical sciences' },
      { article: '1', name: 'Thermodynamics' },
      { article: '2', name: 'Information theory' },
      { article: '2', name: 'Physical sciences' },
      { article: '2', name: 'Thermodynamics' },
      { article: '6', name: 'CS1 references categories' },
      { article: '8', name: 'Information theory' },
      { article: '8', name: 'Thermodynamics' },
      { article: '9', name: 'Physical sciences' },
      { article: '9', name: 'Thermodynamics' },
    ]);
    expect(stats.keptParents).toBe(2);
    expect(stats.keptMembers).toBe(11);
  });

  it('stores cat_pages verbatim and keeps it distinct from the member count', async () => {
    // Task 6 reads articleCount from cat_pages. Counting member rows instead
    // undercounts. Note the fourth category: the meta filter used to drop it
    // here, which meant cat_pages was reported for a table that no longer held
    // every category. It is written now and removed later, in prune.mjs.
    const paths = fixturePaths();
    await ingest(paths);

    expect(rows(paths.db, CATS)).toEqual([
      { name: 'CS1 references categories', cat_pages: 1, cat_subcats: 1 },
      { name: 'Information theory', cat_pages: 5, cat_subcats: 0 },
      { name: 'Physical sciences', cat_pages: 9, cat_subcats: 2 },
      { name: 'Thermodynamics', cat_pages: 7, cat_subcats: 1 },
    ]);
    expect(rows(paths.db, MEMBER_COUNTS)).toEqual([
      { name: 'CS1 references categories', n: 1 },
      { name: 'Information theory', n: 3 },
      { name: 'Physical sciences', n: 3 },
      { name: 'Thermodynamics', n: 4 },
    ]);
  });

  // The defect: ingest used to drop `isMaintenanceCategory` names as they
  // arrived. That made `cat` and `parent` already-filtered, so a category whose
  // parent was filtered away never received a parent edge at all — 42.8% of the
  // real category table had no parent row — and broad fields whose ancestry
  // touched a filtered node could never be restored by pass 5. The meta filter
  // is now a graph-time operation in prune.mjs; ingest writes the complete
  // graph and filters nothing.
  it('writes every category, including the ones the meta filter will remove', async () => {
    const paths = fixturePaths();
    const stats = await ingest(paths);
    expect(stats.rawCategories).toBe(4);
    expect(stats.insertedCategories).toBe(4);
    expect(rows(paths.db, CATS).map(r => r.name)).toContain('CS1 references categories');
    // There is no `afterMetaFilter` any more: ingest filters nothing, and a
    // counter that claimed otherwise is how the defect stayed invisible.
    expect(stats.afterMetaFilter).toBeUndefined();
  });

  it('gives a maintenance category a parent edge, instead of stranding it', async () => {
    // 'CS1 references categories' is ns-14 page 7, filed under 'Physical
    // sciences' by a subcat row. Under the old insert-time filter that row
    // resolved to nothing: the category was gone, so no edge was written, so
    // page 7's category was a root in the atlas. With the filter moved to graph
    // time the edge exists and prune.mjs is what removes the node.
    const paths = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(3,'PHYSICALSCIENCES','2026-07-07 10:01:29','','subcat',1,20184598)",
        "(4,'THERMODYNAMICS','2026-07-07 10:01:29','','subcat',1,20184598)",
        "(7,'CS1REFERENCESCATEGORIES','2026-07-07 10:01:29','','subcat',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184598)",
      ])),
    });
    const stats = await ingest(paths);
    expect(stats.keptParents).toBe(2);
    expect(rows(paths.db, PARENTS)).toEqual([
      { child: 'CS1 references categories', parent: 'Physical sciences' },
      { child: 'Thermodynamics', parent: 'Physical sciences' },
    ]);
  });

  it('reports the cl_target_id resolution rate and logs it', async () => {
    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(m => logged.push(String(m)));
    try {
      const stats = await ingest(fixturePaths());
      expect(stats.linkRows).toBe(14);
      // All 14 cl_target_ids are real ns-14 lt_ids, so all 14 resolve — and all
      // 14 are written. The last one names a maintenance category, which used to
      // be dropped here; the filter runs later now, so keeping it is the
      // correct behaviour rather than an accident.
      expect(stats.resolvedTargets).toBe(14);
      expect(stats.keptTargets).toBe(14);
      expect(stats.targetResolution).toBe(1);
      expect(logged.join('\n')).toMatch(/14\/14 \(100\.00%\)/);
    } finally {
      spy.mockRestore();
    }
  });

  it('cannot be tripped by maintenance categories, because ingest filters nothing', async () => {
    // This used to be the sharpest hazard in the file. 70.6% of categorylinks
    // rows on the real dumps name a category the meta filter drops, so gating
    // the join rate on surviving categories aborted every correct run at 90% and
    // trained the operator to ignore the guard. It needed a second counter,
    // `keptTargets`, to stay honest about the difference.
    //
    // Both the hazard and the workaround are gone: the meta filter is a
    // graph-time operation, so every resolvable target reaches the database and
    // `keptTargets === resolvedTargets` unless a link names a category the
    // dumps do not carry at all. This pins that, on a fixture where 30% of the
    // links point at a maintenance category — the shape that used to fail.
    const rows_ = [];
    for (let i = 0; i < 30; i++) rows_.push("(1,'A','','','page',1,556)");
    for (let i = 0; i < 69; i++) rows_.push("(1,'A','','','page',1,555)");
    // One subcat row, so the run also clears the keptParents floor. It files
    // 'Applied sciences' under 'Physics' and contributes no member row.
    rows_.push("(3,'APPLIEDSCIENCES','','','subcat',1,555)");
    const paths = {
      page: gz("CREATE TABLE `page` (`page_id` int, `page_namespace` int, `page_title` varbinary(255));\n"
        + "INSERT INTO `page` VALUES\n(1,0,'Physics'),\n(2,14,'Physics'),\n(3,14,'Applied sciences');"),
      category: gz("CREATE TABLE `category` (`cat_id` int, `cat_title` varbinary(255), `cat_pages` int, `cat_subcats` int, `cat_files` int);\n"
        + "INSERT INTO `category` VALUES\n(1,'Physics',10,0,0),\n(2,'CS1_references',99,0,0),\n(3,'Applied_sciences',4,1,0);"),
      linktarget: gz("CREATE TABLE `linktarget` (`lt_id` bigint, `lt_namespace` int, `lt_title` varbinary(255));\n"
        + "INSERT INTO `linktarget` VALUES\n(555,14,'Physics'),\n(556,14,'CS1_references');"),
      categorylinks: gz("CREATE TABLE `categorylinks` (`cl_from` int, `cl_sortkey` varbinary(230), `cl_timestamp` timestamp, `cl_sortkey_prefix` varbinary(255), `cl_type` enum('page','subcat','file'), `cl_collation_id` smallint, `cl_target_id` bigint);\n"
        + `INSERT INTO \`categorylinks\` VALUES\n${rows_.join(',\n')};`),
      db: scratch(),
    };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const stats = await ingest(paths);
      expect(stats.linkRows).toBe(100);
      expect(stats.resolvedTargets).toBe(100);
      expect(stats.targetResolution).toBe(1);
      expect(stats.keptTargets).toBe(100);
      expect(stats.keptMembers).toBe(99);
      expect(stats.keptParents).toBe(1);
      // Both categories are on disk, maintenance one included.
      expect(rows(paths.db, CATS).map(r => r.name)).toEqual(
        ['Applied sciences', 'CS1 references', 'Physics'],
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('reports each run separately instead of accumulating counters', async () => {
    const broken = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184599)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184600)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,70122884)",
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,70122885)",
        "(3,'PHYSICALSCIENCES','2026-07-07 10:01:29','','subcat',1,70122886)",
      ])),
    });
    await expect(ingest(broken)).rejects.toThrow(/40\.00%/);
    // A failing run still leaves behind the numbers that explain the failure.
    expect(INGEST_STATS.linkRows).toBe(5);
    expect(INGEST_STATS.resolvedTargets).toBe(2);

    await ingest(fixturePaths());
    expect(INGEST_STATS.linkRows).toBe(14);
    expect(INGEST_STATS.resolvedTargets).toBe(14);
    expect(INGEST_STATS.keptTargets).toBe(14);
  });
});

describe('index safety net', () => {
  // The working database was once found with no indexes at all, and the failure
  // is invisible in every counter ingest prints. `selectMemberSample` issues
  // `WHERE cat = ? LIMIT 200` once per kept category; without `idx_member_cat`
  // that is ~30,000 full scans of a 38.25M-row table. The atlas built is still
  // correct — it just takes 20 minutes where it should take 100 seconds — so
  // nothing fails and the only symptom is that the machine feels slow.
  it('leaves all four indexes in sqlite_master when ingest completes', async () => {
    const paths = fixturePaths();
    await ingest(paths);
    expect(rows(paths.db,
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`,
    ).map(r => r.name)).toEqual([...REQUIRED_INDEXES].sort());
  });

  it('throws, naming the index, when one is missing', () => {
    const db = scratch();
    const handle = new Database(db);
    handle.exec('CREATE TABLE member (article TEXT, cat INTEGER)');
    handle.exec('CREATE TABLE parent (child INTEGER, parent INTEGER)');
    handle.exec('CREATE INDEX idx_member_cat ON member(cat)');
    try {
      expect(() => assertIndexes(handle)).toThrow(/idx_member_article/);
      expect(() => assertIndexes(handle)).toThrow(/idx_parent_child/);
      // The message has to be actionable: this is a "the build is 12x over
      // budget, silently" failure, and the operator is reading one line.
      expect(() => assertIndexes(handle)).toThrow(/20-minute/);
      finalizeIndexes(handle);
      expect(assertIndexes(handle)).toEqual([...REQUIRED_INDEXES]);
    } finally {
      handle.close();
    }
  });

  it('recreates a missing index through finalizeIndexes', () => {
    // The two halves are one contract: finalizeIndexes creates, assertIndexes
    // verifies. Whichever of the four goes missing, the pair covers it.
    const db = scratch();
    const handle = new Database(db);
    handle.exec('CREATE TABLE member (article TEXT, cat INTEGER)');
    handle.exec('CREATE TABLE parent (child INTEGER, parent INTEGER)');
    try {
      for (const name of REQUIRED_INDEXES) {
        handle.exec(`DROP INDEX IF EXISTS ${name}`);
      }
      expect(() => assertIndexes(handle)).toThrow(/4 index\(es\) are missing/);
      finalizeIndexes(handle);
      expect(assertIndexes(handle)).toHaveLength(4);
      // Idempotent, so a second call cannot fail on an existing index.
      finalizeIndexes(handle);
      expect(assertIndexes(handle)).toHaveLength(4);
    } finally {
      handle.close();
    }
  });
});

describe('ingest guards', () => {
  it('throws when linktarget yields no namespace-14 target', async () => {
    // A linktarget dump from a different snapshot, or a wrong file entirely.
    const paths = fixturePaths({
      linktarget: gz(withRows('linktarget', [
        "(20184598,0,'Elsewhere'),",
        "(20184603,6,'Entropy_diagram.svg')",
      ])),
    });
    await expect(ingest(paths)).rejects.toThrow(/linktarget produced zero ns-14 targets/);
    await expect(ingest(paths)).rejects.toThrow(/snapshot/i);
  });

  it('throws when the resolution rate falls below the floor', async () => {
    // The exact failure that cost four hours: cl_target_id resolved against
    // cat_id instead of lt_id. Every other counter still looks plausible, so
    // this must be a hard error rather than a quiet 60% row loss.
    const paths = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184599)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184600)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,70122884)",
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,70122885)",
        "(3,'PHYSICALSCIENCES','2026-07-07 10:01:29','','subcat',1,70122886)",
      ])),
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(ingest(paths)).rejects.toThrow(/40\.00%/);
      await expect(ingest(paths)).rejects.toThrow(/90% required/);
    } finally {
      spy.mockRestore();
    }
  });

  it('throws when no member row survives, even though every target resolved', async () => {
    const paths = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(4,'THERMODYNAMICS','2026-07-07 10:01:29','','subcat',1,20184598)",
        "(5,'INFORMATIONTHEORY','2026-07-07 10:01:29','','subcat',1,20184598)",
      ])),
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(ingest(paths)).rejects.toThrow(/zero member rows/);
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores a linktarget row outside namespace 14 even when its title matches', async () => {
    // lt_id 556 is namespace 0 with the title 'Physics'. Accepting it would
    // forge a link from a categorylinks row that names no category at all.
    // One of the eleven resolving rows is a subcat edge so the run also clears
    // the keptParents floor; it names 'Applied sciences', not 'Physics', so the
    // member list below still proves the decoy produced nothing.
    const links = ["(1,'A','','','page',1,555)"];
    for (let i = 0; i < 9; i++) links.push(`(1,'A','','','page',1,555)`);
    links.push("(3,'APPLIEDSCIENCES','','','subcat',1,555)");
    links.push("(1,'A','','','page',1,556)");
    const paths = {
      page: gz("CREATE TABLE `page` (`page_id` int, `page_namespace` int, `page_title` varbinary(255));\n"
        + "INSERT INTO `page` VALUES\n(1,0,'Physics'),\n(2,14,'Physics'),\n(3,14,'Applied sciences');"),
      category: gz("CREATE TABLE `category` (`cat_id` int, `cat_title` varbinary(255), `cat_pages` int, `cat_subcats` int, `cat_files` int);\n"
        + "INSERT INTO `category` VALUES\n(1,'Physics',10,0,0),\n(2,'Applied_sciences',4,1,0);"),
      linktarget: gz("CREATE TABLE `linktarget` (`lt_id` bigint, `lt_namespace` int, `lt_title` varbinary(255));\n"
        + "INSERT INTO `linktarget` VALUES\n(555,14,'Physics'),\n(556,0,'Physics');"),
      categorylinks: gz("CREATE TABLE `categorylinks` (`cl_from` int, `cl_sortkey` varbinary(230), `cl_timestamp` timestamp, `cl_sortkey_prefix` varbinary(255), `cl_type` enum('page','subcat','file'), `cl_collation_id` smallint, `cl_target_id` bigint);\n"
        + `INSERT INTO \`categorylinks\` VALUES\n${links.join(',\n')};`),
      db: scratch(),
    };
    const stats = await ingest(paths);
    expect(stats.linkRows).toBe(12);
    expect(stats.resolvedTargets).toBe(11);
    expect(stats.keptTargets).toBe(11);
    expect(stats.keptMembers).toBe(10);
    expect(stats.keptParents).toBe(1);
    expect(rows(paths.db, MEMBERS)).toEqual(
      Array.from({ length: 10 }, () => ({ article: '1', name: 'Physics' })),
    );
  });

  it('throws when no parent row survives, even though every target resolved', async () => {
    // The gate the member floor does not cover. Every link here resolves to a
    // live category and cl_type is 'page', so keptMembers is 13 and the
    // resolution rate is 100%: both existing guards pass. Only the absence of
    // parent edges gives it away — an atlas of 13 members and no hierarchy,
    // which is exactly what a dead cl_type branch would ship on a full run.
    const paths = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184599)",
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184600)",
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184599)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184600)",
      ])),
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(ingest(paths)).rejects.toThrow(/zero parent edges from 0 subcat rows/);
      // The run got far enough to write a healthy member table, so the rate
      // guard and the member floor both passed first.
      expect(INGEST_STATS.keptMembers).toBe(6);
      expect(INGEST_STATS.keptParents).toBe(0);
      expect(INGEST_STATS.targetResolution).toBe(1);
      expect(INGEST_STATS.subcatRows).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('separates a dead subcat branch from subcat rows that were all dropped', async () => {
    // Same zero parents as the previous test, but subcat rows DO exist: page 3
    // files itself under its own category, so the one subcat row is a self edge
    // and never reaches the parent table. subcatRows is what tells an operator
    // which of the two they are looking at; keptParents alone says only "0".
    const paths = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(3,'PHYSICALSCIENCES','2026-07-07 10:01:29','','subcat',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184599)",
      ])),
    });
    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(m => logged.push(String(m)));
    try {
      await expect(ingest(paths)).rejects.toThrow(/zero parent edges from 1 subcat rows/);
      expect(INGEST_STATS.subcatRows).toBe(1);
      expect(INGEST_STATS.keptParents).toBe(0);
      expect(INGEST_STATS.keptMembers).toBe(2);
      expect(logged.join('\n')).toMatch(/subcat rows: 1 \(0 parent edges written\)/);
    } finally {
      spy.mockRestore();
    }
  });

  it('counts subcat rows ahead of the self-edge drop', async () => {
    // The fixture's three subcat rows are two real edges and one self edge
    // (page 3 under its own category). subcatRows counts all three; the self
    // edge never reaches the parent table, which is what makes the counter
    // worth having — it is read on the real dumps, where subcat is 2.02%.
    const stats = await ingest(fixturePaths());
    expect(stats.subcatRows).toBe(3);
    expect(stats.keptParents).toBe(2);
  });

  it('builds the whole page->category map before the name map is released', async () => {
    // ingest clears idByName after pass B, before pass C, to keep the pass-C
    // peak down. idByPageId is the only thing pass C reads from pass B, and it
    // is built entirely during the pass that still has idByName in hand: if the
    // clear were moved a line earlier, or the pass-B lookup were changed to read
    // a cleared map, every parent edge would silently vanish (Map.get returns
    // undefined, and undefined is already the "not a category page" path).
    // This asserts both halves of that contract on the same fixture.
    const paths = fixturePaths();
    const stats = await ingest(paths);
    expect(stats.subcatRows).toBe(3);
    expect(stats.keptParents).toBe(2);
    expect(rows(paths.db, PARENTS)).toEqual([
      { child: 'Information theory', parent: 'Physical sciences' },
      { child: 'Thermodynamics', parent: 'Physical sciences' },
    ]);
  });

  it('validates every dump schema before deleting an existing database', async () => {
    const db = scratch();
    const prior = new Database(db);
    prior.exec('CREATE TABLE prior_result (x)');
    prior.close();

    const paths = fixturePaths({
      // No `categorylinks` table at all: readDumpSchema finds page instead.
      categorylinks: gz("CREATE TABLE `page` (`a` int);\nINSERT INTO `page` VALUES (1);"),
      db,
    });
    await expect(ingest(paths)).rejects.toThrow(/categorylinks/);
    expect(rows(db, `SELECT name FROM sqlite_master WHERE name='prior_result'`))
      .toEqual([{ name: 'prior_result' }]);
  });

  it('rejects a page row whose width disagrees with its declared schema', async () => {
    // The width guard must not sit behind the namespace filter it validates: a
    // dump whose columns shifted would otherwise go unnoticed for as long as
    // every category page happened to be absent.
    const good = gz(FIXTURE_SQL);
    const paths = {
      page: gz("CREATE TABLE `page` (`page_id` int, `page_namespace` int, `page_title` varbinary(255), `page_is_redirect` tinyint);\n"
        + "INSERT INTO `page` VALUES\n(1,0,'Physics');"),
      category: good, linktarget: good, categorylinks: good,
      db: scratch(),
    };
    await expect(ingest(paths)).rejects.toThrow(/`page` row has 3 fields, schema declares 4/);
  });

  it('rejects a malformed row in the MIDDLE of a table, not just the first', async () => {
    // The guard used to run once per table, behind a `guarded` flag. A truncated
    // row anywhere else parsed without error and shifted every column after the
    // gap. The dangerous case is not a throw: lt_title and cl_target_id both
    // still hold *valid* values after a shift, so the row resolves, every
    // counter stays healthy, and the run writes a wrong graph. No floor added
    // downstream can catch that. This row is the 8th of 14.
    const malformed = fixturePaths({
      categorylinks: gz(withRows('categorylinks', [
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184599)",
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184600)",
        "(2,'ENTROPY','2026-07-07 10:01:29','','page',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184598)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184599)",
        "(1,'PHYSICS','2026-07-07 10:01:29','','page',1,20184600)",
        "(8,'QUANTUMMECHANICS','2026-07-07 10:01:29','','page',1,20184598)",
        // One field short: cl_sortkey_prefix is missing, so every column after
        // it lands one position to the left.
        "(8,'QUANTUMMECHANICS','2026-07-07 10:01:29','page',1,20184599)",
      ])),
    });
    await expect(ingest(malformed)).rejects.toThrow(
      /`categorylinks` row has 6 fields, schema declares 7/,
    );
  });

  it('rejects a malformed row that the old first-row-only guard dropped silently', async () => {
    // The concrete failure the per-row guard exists to prevent, measured under
    // the OLD behaviour: this run SUCCEEDED with 92.31% resolution, 6 parent
    // edges and 6 members — every counter healthy, no floor tripped, no
    // operator-facing signal of any kind — while the truncated row vanished.
    // One lost row is harmless; the same shift on a real dump silently drops
    // whichever rows land malformed, and shifts their surviving columns into
    // whatever sits next.
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push("(1,'A','','','page',1,20184598)");
    // One field short. cl_type still reads 'page' from the shifted field and
    // cl_target_id is absent, so the row resolves to nothing and is discarded
    // without complaint.
    rows.push("(1,'A','','','page',1)");
    for (let i = 0; i < 6; i++) rows.push("(4,'A','','','subcat',1,20184598)");
    const paths = fixturePaths({
      categorylinks: gz(withRows('categorylinks', rows)),
    });
    await expect(ingest(paths)).rejects.toThrow(
      /`categorylinks` row has 6 fields, schema declares 7/,
    );
  });

  it('rejects a malformed row in the middle of the page table', async () => {
    // The other three passes had the same flag. `page` is the one where a
    // silent shift is hardest to notice: it feeds idByPageId, so a truncated
    // row quietly drops a category page and the parent edge it would have
    // produced, with no counter recording the loss. The first two rows are
    // well formed, so a first-row-only guard would never see this one.
    const good = gz(FIXTURE_SQL);
    const withBad = FIXTURE_SQL.replace(
      /INSERT INTO `page` VALUES[\s\S]*?;/,
      "INSERT INTO `page` VALUES\n"
      + "(1,0,'Physics',0,0,0.856935107283,'20260731120255',NULL,1367012995,111,'wikitext',NULL),\n"
      + "(2,0,'Entropy',0,0,0.870480291199,'20260805045949',NULL,1367786022,113994,'wikitext',NULL),\n"
      // page_is_new (the 5th field) is missing: 11 fields against a schema of 12.
      + "(3,14,'Physical sciences',0,0.13895768761,'20260718034000',NULL,783865149,90,'wikitext',NULL),",
    );
    const paths = {
      page: gz(withBad), category: good, linktarget: good, categorylinks: good,
      db: scratch(),
    };
    await expect(ingest(paths)).rejects.toThrow(/`page` row has 11 fields, schema declares 12/);
  });
});

describe('missingInputs', () => {
  const absent = name => join(tmpdir(), `atlas-absent-${name}.sql.gz`);

  it('gitignores every dump it will ever look for', () => {
    // ingest prefers this repo directory whenever enwiki-latest-page.sql.gz is
    // here, so the dumps are as likely to land inside the repo as beside it.
    // Each is 2.5 GB; one accidental `git add .` must not stage one. The
    // patterns are read from .gitignore rather than restated as constants, so
    // deleting the rule fails this test instead of failing quietly on main.
    //
    // memex/.gitignore, three levels up from scripts/lib/__tests__/. Four levels up
    // is the PARENT repo, which has its own copy of the rule — reading that made
    // this test pass even with both rules deleted from here, which is the exact
    // failure it exists to prevent. The assertion below pins the repo root to the
    // one that actually holds scripts/ingest.mjs, so that cannot regress.
    const repoRoot = new URL('../../../', import.meta.url);
    expect(existsSync(new URL('scripts/ingest.mjs', repoRoot))).toBe(true);

    const ignoreFile = readFileSync(new URL('.gitignore', repoRoot), 'utf8');
    const patterns = ignoreFile.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => (l.startsWith('/') ? l.slice(1) : l).replace(/\/$/, ''));
    // gitignore glob, restricted to the '*' that these rules actually use.
    const matches = (pattern, name) => new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    ).test(name);

    for (const key of ['page', 'category', 'categorylinks', 'linktarget']) {
      const name = PATHS[key].split('/').pop();
      expect(patterns.some(p => matches(p, name)), `${key} dump (${name}) is not gitignored`)
        .toBe(true);
    }
  });

  it('checks all four dumps, linktarget included', () => {
    expect(Object.keys(PATHS)).toEqual(
      expect.arrayContaining(['page', 'category', 'categorylinks', 'linktarget', 'db']),
    );
    expect(missingInputs({
      page: absent('page'), category: absent('category'),
      categorylinks: absent('categorylinks'), linktarget: absent('linktarget'),
    })).toHaveLength(4);
  });

  it('reports only the dumps that are actually missing', () => {
    const paths = fixturePaths({ linktarget: absent('linktarget') });
    expect(missingInputs(paths)).toEqual([absent('linktarget')]);
    expect(missingInputs(fixturePaths())).toEqual([]);
  });

  it('stops before creating a database when a dump is missing', async () => {
    const db = scratch();
    await expect(ingest(fixturePaths({ linktarget: absent('linktarget'), db })))
      .rejects.toThrow(/Missing input dumps/);
    expect(existsSync(db)).toBe(false);
  });
});
