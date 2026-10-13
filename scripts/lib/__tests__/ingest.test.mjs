import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ingest, missingInputs, PATHS, INGEST_STATS } from '../../ingest.mjs';

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
      { article: '8', name: 'Information theory' },
      { article: '8', name: 'Thermodynamics' },
      { article: '9', name: 'Physical sciences' },
      { article: '9', name: 'Thermodynamics' },
    ]);
    expect(stats.keptParents).toBe(2);
    expect(stats.keptMembers).toBe(10);
  });

  it('stores cat_pages verbatim and keeps it distinct from the member count', async () => {
    // Task 6 reads articleCount from cat_pages. Counting member rows instead
    // undercounts, because member rows only exist for links that survived the
    // meta filter and the join.
    const paths = fixturePaths();
    await ingest(paths);

    expect(rows(paths.db, CATS)).toEqual([
      { name: 'Information theory', cat_pages: 5, cat_subcats: 0 },
      { name: 'Physical sciences', cat_pages: 9, cat_subcats: 2 },
      { name: 'Thermodynamics', cat_pages: 7, cat_subcats: 1 },
    ]);
    expect(rows(paths.db, MEMBER_COUNTS)).toEqual([
      { name: 'Information theory', n: 3 },
      { name: 'Physical sciences', n: 3 },
      { name: 'Thermodynamics', n: 4 },
    ]);
  });

  it('counts the categories the meta filter keeps, not the rows it reads', async () => {
    const stats = await ingest(fixturePaths());
    expect(stats.rawCategories).toBe(4);
    expect(stats.afterMetaFilter).toBe(3);
  });

  it('reports the cl_target_id resolution rate and logs it', async () => {
    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(m => logged.push(String(m)));
    try {
      const stats = await ingest(fixturePaths());
      expect(stats.linkRows).toBe(14);
      // All 14 cl_target_ids are real ns-14 lt_ids, so all 14 resolve. One of
      // the categories they name is dropped by the meta filter, which is a
      // separate, expected loss and is reported on its own.
      expect(stats.resolvedTargets).toBe(14);
      expect(stats.keptTargets).toBe(13);
      expect(stats.targetResolution).toBe(1);
      expect(logged.join('\n')).toMatch(/14\/14 \(100\.00%\)/);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not let meta-filtered categories trip the resolution guard', async () => {
    // Measured on the real dumps: 70.6% of categorylinks rows name a category
    // the meta filter drops, because maintenance categories are the most
    // heavily linked ones on Wikipedia. Gating the join rate on surviving
    // categories would therefore abort every real run at 90% and train the
    // operator to ignore the guard. The guard measures the join; the meta
    // filter's cost is logged separately.
    const dropped = [];
    for (let i = 0; i < 9; i++) dropped.push(`(1,'A','','','page',1,556)`);
    const kept = [];
    for (let i = 0; i < 91; i++) kept.push(`(1,'A','','','page',1,555)`);
    const paths = {
      page: gz("CREATE TABLE `page` (`page_id` int, `page_namespace` int, `page_title` varbinary(255));\n"
        + "INSERT INTO `page` VALUES\n(1,0,'Physics'),\n(2,14,'Physics');"),
      category: gz("CREATE TABLE `category` (`cat_id` int, `cat_title` varbinary(255), `cat_pages` int, `cat_subcats` int, `cat_files` int);\n"
        + "INSERT INTO `category` VALUES\n(1,'Physics',10,0,0),\n(2,'CS1_references',99,0,0);"),
      // 556 is a genuine category target whose category the meta filter drops.
      linktarget: gz("CREATE TABLE `linktarget` (`lt_id` bigint, `lt_namespace` int, `lt_title` varbinary(255));\n"
        + "INSERT INTO `linktarget` VALUES\n(555,14,'Physics'),\n(556,14,'CS1_references');"),
      categorylinks: gz("CREATE TABLE `categorylinks` (`cl_from` int, `cl_sortkey` varbinary(230), `cl_timestamp` timestamp, `cl_sortkey_prefix` varbinary(255), `cl_type` enum('page','subcat','file'), `cl_collation_id` smallint, `cl_target_id` bigint);\n"
        + `INSERT INTO \`categorylinks\` VALUES\n${[...kept, ...dropped].join(',\n')};`),
      db: scratch(),
    };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const stats = await ingest(paths);
      expect(stats.linkRows).toBe(100);
      expect(stats.resolvedTargets).toBe(100);
      expect(stats.targetResolution).toBe(1);
      expect(stats.keptTargets).toBe(91);
      expect(stats.keptMembers).toBe(91);
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
    expect(INGEST_STATS.keptTargets).toBe(13);
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
    const links = ["(1,'A','','','page',1,555)"];
    for (let i = 0; i < 10; i++) links.push(`(1,'A','','','page',1,555)`);
    links.push("(1,'A','','','page',1,556)");
    const paths = {
      page: gz("CREATE TABLE `page` (`page_id` int, `page_namespace` int, `page_title` varbinary(255));\n"
        + "INSERT INTO `page` VALUES\n(1,0,'Physics'),\n(2,14,'Physics');"),
      category: gz("CREATE TABLE `category` (`cat_id` int, `cat_title` varbinary(255), `cat_pages` int, `cat_subcats` int, `cat_files` int);\n"
        + "INSERT INTO `category` VALUES\n(1,'Physics',10,0,0);"),
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
    expect(stats.keptMembers).toBe(11);
    expect(rows(paths.db, MEMBERS)).toEqual(
      Array.from({ length: 11 }, () => ({ article: '1', name: 'Physics' })),
    );
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
});

describe('missingInputs', () => {
  const absent = name => join(tmpdir(), `atlas-absent-${name}.sql.gz`);

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
