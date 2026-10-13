import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamInsertRows, readDumpSchema } from '../sql-stream.mjs';
import { normalizeCategoryName } from '../categories.mjs';

function gz(sql) {
  const path = join(mkdtempSync(join(tmpdir(), 'atlas-sql-')), 'f.sql.gz');
  writeFileSync(path, gzipSync(Buffer.from(sql, 'utf8')));
  return path;
}

/** Deterministic filler so a big statement cannot be squeezed away by gzip. */
function noise(n) {
  let s = '';
  let x = (n + 1) * 2654435761 % 4294967296;
  for (let i = 0; i < 6; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += x.toString(36);
  }
  return s;
}

const FIXTURE = gz(readFileSync(new URL('../../fixtures/mini-dump.sql', import.meta.url), 'utf8'));

describe('streamInsertRows', () => {
  it('parses every row across all tables', async () => {
    const seen = [];
    await streamInsertRows(FIXTURE, (t, v) => seen.push([t, v.length]));
    expect(seen.filter(s => s[0] === 'page')).toHaveLength(9);
    expect(seen.filter(s => s[0] === 'category')).toHaveLength(4);
    expect(seen.filter(s => s[0] === 'linktarget')).toHaveLength(7);
    expect(seen.filter(s => s[0] === 'categorylinks')).toHaveLength(14);
  });

  it('handles multi-row INSERT statements without dropping rows', async () => {
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'page') rows.push(v[2]); });
    expect(rows).toEqual([
      'Physics', 'Entropy', 'Physical sciences', 'Thermodynamics',
      'Information theory', 'CS1 references', 'CS1 references categories',
      'Quantum mechanics', 'Black hole',
    ]);
  });

  it('exposes every column of the real page row shape', async () => {
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'page') rows.push(v); });
    expect(rows[0]).toEqual([
      '1', '0', 'Physics', '0', '0', '0.856935107283',
      '20260731120255', '', '1367012995', '111', 'wikitext', '',
    ]);
  });

  it('exposes categorylinks by id, never by name', async () => {
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'categorylinks') rows.push(v); });
    // cl_from, cl_type, cl_target_id. The category title is not in this table,
    // and cl_target_id is a linktarget.lt_id, not the page_id or the cat_id of
    // the category.
    expect(rows[0]).toEqual([
      '3', 'PHYSICALSCIENCES', '2026-07-07 10:01:29', '', 'subcat', '1', '20184598',
    ]);
  });

  it('exposes linktarget by namespace and title', async () => {
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'linktarget') rows.push(v); });
    expect(rows[0]).toEqual(['60335879', '-2', 'Example.jpg']);
    expect(rows.map(r => r[1])).toContain('14');
  });

  it('resolves every category target through cl_target_id -> lt_id -> lt_title', async () => {
    // The failure this guards against is silent and total: categorylinks has no
    // title column, and the only way to name a target is to join through
    // linktarget. Resolving cl_target_id against cat_id or page_id instead
    // discards almost every row while every counter still looks plausible.
    const targets = new Map();
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t === 'linktarget') targets.set(Number(v[0]), v[2]);
    });
    const catTitles = new Set();
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t === 'category') catTitles.add(normalizeCategoryName(v[1]));
    });

    const names = [];
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t !== 'categorylinks') return;
      names.push(targets.get(Number(v[6])));
    });

    // Every cl_target_id in the fixture is a real lt_id, so all 14 rows name a
    // category. lt_title carries underscores and meets cat_title only after
    // normalisation, which is why ingest normalises both sides.
    expect(names).toHaveLength(14);
    expect(names.every(n => catTitles.has(normalizeCategoryName(n)))).toBe(true);
    const tally = n => names.filter(x => normalizeCategoryName(x) === n).length;
    expect(tally('Physical sciences')).toBe(6);
    expect(tally('Thermodynamics')).toBe(4);
    expect(tally('Information theory')).toBe(3);
    expect(tally('CS1 references categories')).toBe(1);
  });

  it('keeps lt_id, cat_id and page_id in separate id spaces', async () => {
    // Guards the failure that costs the most: joining categorylinks.cl_target_id
    // to page.page_id or category.cat_id because the three look like
    // interchangeable ids.
    const ltIds = new Set();
    const catIds = new Set();
    const pageIds = new Set();
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t === 'linktarget') ltIds.add(Number(v[0]));
      if (t === 'category') catIds.add(Number(v[0]));
      if (t === 'page') pageIds.add(Number(v[0]));
    });

    let checked = 0;
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t !== 'categorylinks') return;
      const id = Number(v[6]);
      expect(ltIds.has(id)).toBe(true);
      expect(catIds.has(id)).toBe(false);
      expect(pageIds.has(id)).toBe(false);
      checked++;
    });
    expect(checked).toBe(14);
  });

  it('carries a decoy linktarget row outside namespace 14 that shares a category title', async () => {
    // lt_id 20184602 is namespace 0 with the title 'Physical_sciences'. If the
    // namespace filter were dropped it would forge a second mapping onto a real
    // category; the fixture must keep the filter load-bearing.
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'linktarget') rows.push(v); });
    const decoy = rows.find(r => r[0] === '20184602');
    expect(decoy).toEqual(['20184602', '0', 'Physical_sciences']);
  });

  it('handles commas and escaped quotes inside string values', async () => {
    const rows = [];
    await streamInsertRows(gz("INSERT INTO `page` VALUES\n(1,0,'Smith, John: a \"quote\"','',0,0);"),
      (t, v) => rows.push(v[2]));
    expect(rows[0]).toBe('Smith, John: a "quote"');
  });

  it('handles NULL values as empty strings', async () => {
    const rows = [];
    await streamInsertRows(gz("INSERT INTO `page` VALUES\n(1,0,'X',NULL,0,0);"), (t, v) => rows.push(v));
    expect(rows[0]).toEqual(['1', '0', 'X', '', '0', '0']);
  });

  it('resolves without error on an empty file', async () => {
    let called = 0;
    await streamInsertRows(gz(''), () => { called++; });
    expect(called).toBe(0);
  });

  it('handles a statement split across stream chunks', async () => {
    const rows = [];
    await streamInsertRows(gz("INSERT INTO `page` VALUES\n" +
      Array.from({ length: 500 }, (_, i) => `(1${i},0,'Page ${i}','',0,0)`).join(',\n') + ';'),
      (t, v) => rows.push(v[2]));
    expect(rows).toHaveLength(500);
    expect(rows[499]).toBe('Page 499');
  });

  it('streams a statement thousands of times larger than one chunk', async () => {
    const count = 30000;
    const tuples = Array.from({ length: count },
      (_, i) => `(${1000 + i},0,'Page ${i} ${noise(i)}',0,0)`);
    const rows = [];
    await streamInsertRows(gz('INSERT INTO `page` VALUES\n' + tuples.join(',\n') + ';'),
      (t, v) => rows.push(v[2]));
    expect(rows).toHaveLength(count);
    expect(rows[0]).toBe(`Page 0 ${noise(0)}`);
    expect(rows[count - 1]).toBe(`Page ${count - 1} ${noise(count - 1)}`);
  });

  it('keeps a header intact when INSERT straddles a chunk boundary', async () => {
    // createGunzip emits 16384-byte chunks, so the INSERT keyword can be placed
    // to sit exactly on the seam: 'INS' in one chunk, 'ERT INTO ...' in the next.
    const seam = 16384;
    const pad = '-- ' + 'x'.repeat(seam - 7) + '\n';
    expect(Buffer.byteLength(pad)).toBe(seam - 3);
    const rows = [];
    await streamInsertRows(gz(pad + "INSERT INTO `page` VALUES\n(1,0,'Alpha',0,0),\n(2,0,'Beta',0,0);"),
      (t, v) => rows.push(v[2]));
    expect(rows).toEqual(['Alpha', 'Beta']);
  });

  it('does not end a statement at a semicolon inside a string value', async () => {
    const rows = [];
    await streamInsertRows(gz(
      "INSERT INTO `page` VALUES\n(1,0,'Foo; bar',0,0),\n(2,0,'Baz',0,0),\n(3,0,'Q; R',0,0);\n" +
      "INSERT INTO `page` VALUES\n(4,0,'After',0,0);"),
      (t, v) => rows.push(v[2]));
    expect(rows).toEqual(['Foo; bar', 'Baz', 'Q; R', 'After']);
  });

  it('does not end a statement at an escaped semicolon inside a string value', async () => {
    const rows = [];
    await streamInsertRows(gz(
      "INSERT INTO `page` VALUES\n(1,0,'back\\\\slash; still one value',0,0);\n" +
      "INSERT INTO `page` VALUES\n(2,0,'After',0,0);"),
      (t, v) => rows.push(v[2]));
    expect(rows).toEqual(['back\\slash; still one value', 'After']);
  });

  it('throws instead of buffering forever when a statement never terminates', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atlas-sql-')), 'unterminated.sql.gz');
    // Tuples with no ';' anywhere: the guard must fire rather than grow the
    // buffer without bound. The limit is lowered so the test stays fast; the
    // default 64 MB backstop is what protects the real dumps.
    const filler = `(1,0,'${'x'.repeat(900)}',0,0)`;
    const sql = 'INSERT INTO `page` VALUES\n' + filler.repeat(1000);
    writeFileSync(path, gzipSync(Buffer.from(sql, 'utf8')));
    await expect(streamInsertRows(path, () => {}, { maxStatement: 4096 }))
      .rejects.toThrow(/exceeded 4096 bytes without a terminator/);
  });

  it('accepts a statement at or below the runaway backstop', async () => {
    const rows = [];
    const tuples = Array.from({ length: 50 }, (_, i) => `(1${i},0,'P ${i}',0,0)`);
    await streamInsertRows(gz(`INSERT INTO \`page\` VALUES\n${tuples.join(',')};\n`),
      (t, v) => rows.push(v[2]), { maxStatement: 4096 });
    expect(rows).toHaveLength(50);
  });
});

describe('readDumpSchema', () => {
  it('reads page columns in declaration order', async () => {
    const schema = await readDumpSchema(FIXTURE);
    expect(schema.get('page')).toEqual([
      'page_id', 'page_namespace', 'page_title', 'page_is_redirect', 'page_is_new',
      'page_random', 'page_touched', 'page_links_updated', 'page_latest', 'page_len',
      'page_content_model', 'page_lang',
    ]);
  });

  it('reads categorylinks columns and skips table constraints', async () => {
    const schema = await readDumpSchema(FIXTURE);
    expect(schema.get('categorylinks')).toEqual([
      'cl_from', 'cl_sortkey', 'cl_timestamp', 'cl_sortkey_prefix',
      'cl_type', 'cl_collation_id', 'cl_target_id',
    ]);
  });

  it('reads the category table that carries the names and counts', async () => {
    const schema = await readDumpSchema(FIXTURE);
    expect(schema.get('category')).toEqual([
      'cat_id', 'cat_title', 'cat_pages', 'cat_subcats', 'cat_files',
    ]);
  });

  it('reads linktarget, the table categorylinks.cl_target_id points at', async () => {
    const schema = await readDumpSchema(FIXTURE);
    expect(schema.get('linktarget')).toEqual(['lt_id', 'lt_namespace', 'lt_title']);
  });

  it('reports nothing for a dump with no CREATE TABLE', async () => {
    const schema = await readDumpSchema(gz("INSERT INTO `page` VALUES (1,0,'X',0,0);"));
    expect(schema.size).toBe(0);
  });
});