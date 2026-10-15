import Database from 'better-sqlite3';

/**
 * Cross-link discovery (Task 7). Two categories are cross-linked when they
 * share members: the edge weight is the number of distinct articles filed
 * under both. This is the only signal in the input data that relates
 * categories that pass 2 did not make parent/child, so it is what keeps the
 * atlas from being 30,000 disconnected trees.
 *
 * Scale: the candidate set is ~30k categories and the member table ~150M
 * rows, so nothing here scans `member` as a whole. Each candidate
 * contributes at most `crosslinkMemberSample` members (deterministic: the
 * lowest article ids, via the idx_member_cat index), the sampled pairs go
 * into a temp table, and SQLite does the pair counting with a self-join —
 * the k^2 blowup on hub articles is real (an article in 300 kept categories
 * emits ~45k pairs) and a JS Map of every candidate pair does not fit in the
 * 4 GB budget, while SQLite's sorter spills to disk.
 *
 * Selection is the greedy top-K the params describe, expressed as two window
 * functions: a pair survives only if it is in the top `crosslinkTopK` of
 * BOTH endpoints (a hub fills its slots with its biggest overlaps, so a
 * pair that is merely a hub's 25th-best is not a relationship the hub can
 * show), then the survivors are cut by `crosslinkGlobalCap` ordered by
 * shared count. The result is deterministic: every ORDER BY is total.
 *
 * Endpoints are SQLite cat.id values, not dense node indices — the caller
 * remaps them after the rank cut, and edges whose endpoint was pruned are
 * dropped there.
 */

const INSERT_BATCH = 50_000;

/**
 * @param {string} dbPath SQLite database produced by ingest.mjs
 * @param {object} params
 * @param {number} [params.crosslinkMinArticleCount] fallback candidate floor
 *   when `keptIds` is absent: only categories with at least this many pages
 * @param {number} [params.crosslinkMinShared] minimum shared members
 * @param {number} [params.crosslinkTopK] max edges per endpoint
 * @param {number} [params.crosslinkGlobalCap] max edges returned
 * @param {number} [params.crosslinkMemberSample] max members sampled per category
 * @param {Iterable<number>} [params.keptIds] SQLite cat.id values to consider.
 *   When present this IS the candidate set: the rank cut has already decided
 *   which categories exist in the atlas, and edges to anything else would be
 *   dropped at remap time anyway.
 * @returns {{a: number, b: number, shared: number}[]} a < b, unsorted
 */
export function crosslink(dbPath, params = {}) {
  const {
    crosslinkMinArticleCount = 10,
    crosslinkMinShared = 3,
    crosslinkTopK = 20,
    crosslinkGlobalCap = 400_000,
    crosslinkMemberSample = 200,
    keptIds,
  } = params;

  const db = new Database(dbPath, { readonly: true });
  try {
    let candidates;
    if (keptIds !== undefined) {
      candidates = Array.from(keptIds);
    } else {
      candidates = db.prepare(
        'SELECT id FROM cat WHERE cat_pages >= ? ORDER BY id',
      ).all(crosslinkMinArticleCount).map(r => r.id);
    }
    if (candidates.length === 0) return [];

    db.exec('CREATE TEMP TABLE samp (article TEXT NOT NULL, cat INTEGER NOT NULL, PRIMARY KEY (article, cat)) WITHOUT ROWID');
    const insSamp = db.prepare('INSERT OR IGNORE INTO samp (article, cat) VALUES (?, ?)');
    const sampleOne = db.prepare(
      'SELECT article, cat FROM member WHERE cat = ? ORDER BY article LIMIT ?',
    );

    // One transaction: 30k index range scans of <=200 rows each. Committing
    // per category would fsync 30k times; one commit makes the whole sample
    // a single durable write.
    db.exec('BEGIN');
    let pending = 0;
    for (const id of candidates) {
      for (const row of sampleOne.all(id, crosslinkMemberSample)) {
        insSamp.run(row.article, row.cat);
        pending++;
      }
      if (pending >= INSERT_BATCH) { db.exec('COMMIT'); db.exec('BEGIN'); pending = 0; }
    }
    db.exec('COMMIT');

    // The self-join is the pair counter. Index (article, cat) turns each
    // probe into a range scan bounded by the article's own member list, and
    // the sorter behind GROUP BY spills to disk, so the hub k^2 costs disk
    // and minutes rather than the JS heap.
    db.exec('CREATE INDEX idx_samp ON samp (article, cat)');
    db.exec(
      'CREATE TEMP TABLE pairs AS '
      + 'SELECT s1.cat AS a, s2.cat AS b, COUNT(*) AS shared '
      + 'FROM samp s1 JOIN samp s2 ON s1.article = s2.article AND s1.cat < s2.cat '
      + 'GROUP BY s1.cat, s2.cat '
      + `HAVING COUNT(*) >= ${Math.max(1, crosslinkMinShared | 0)}`,
    );

    // Top-K per endpoint, then the global cap. Both window functions sort
    // the same pairs table; SQLite materialises it once and sorts twice.
    const rows = db.prepare(
      'SELECT a, b, shared FROM ('
      + '  SELECT a, b, shared,'
      + '    ROW_NUMBER() OVER (PARTITION BY a ORDER BY shared DESC, b ASC) AS ra,'
      + '    ROW_NUMBER() OVER (PARTITION BY b ORDER BY shared DESC, a ASC) AS rb'
      + '  FROM pairs'
      + `) WHERE ra <= ${Math.max(1, crosslinkTopK | 0)} AND rb <= ${Math.max(1, crosslinkTopK | 0)} `
      + 'ORDER BY shared DESC, a ASC, b ASC '
      + `LIMIT ${Math.max(1, crosslinkGlobalCap | 0)}`,
    ).all();

    return rows.map(r => ({ a: r.a, b: r.b, shared: r.shared }));
  } finally {
    db.close();
  }
}
