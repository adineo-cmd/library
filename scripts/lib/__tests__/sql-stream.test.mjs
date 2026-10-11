import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamInsertRows, readDumpSchema } from '../sql-stream.mjs';

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
    expect(seen.filter(s => s[0] === 'page')).toHaveLength(7);
    expect(seen.filter(s => s[0] === 'categorylinks')).toHaveLength(8);
  });

  it('handles multi-row INSERT statements without dropping rows', async () => {
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'page') rows.push(v[2]); });
    expect(rows).toEqual([
      'Physics', 'Entropy', 'Physical sciences', 'Thermodynamics',
      'Information theory', 'CS1 references', 'CS1 references categories',
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
    // and cl_target_id is a cat_id, not the page_id of the category page.
    expect(rows[0]).toEqual([
      '3', 'PHYSICALSCIENCES', '2026-07-07 10:01:29', '', 'subcat', '1', '70122884',
    ]);
  });

  it('keeps cat_id and page_id in separate id spaces', async () => {
    // Guards the failure that costs the most: joining categorylinks.cl_target_id
    // to page.page_id because the two look like interchangeable ids.
    const cats = new Map();
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t === 'category') cats.set(Number(v[0]), v[1]);
    });
    await streamInsertRows(FIXTURE, (t, v) => {
      if (t !== 'categorylinks' || v[4] !== 'subcat') return;
      const target = cats.get(Number(v[6]));
      expect(target).toBeDefined();
      expect(target).toBe('Physical sciences');
    });
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

  it('reads the category table that carries the names', async () => {
    const schema = await readDumpSchema(FIXTURE);
    expect(schema.get('category')).toEqual([
      'cat_id', 'cat_title', 'cat_pages', 'cat_subcats', 'cat_hidden',
    ]);
  });

  it('reports nothing for a dump with no CREATE TABLE', async () => {
    const schema = await readDumpSchema(gz("INSERT INTO `page` VALUES (1,0,'X',0,0);"));
    expect(schema.size).toBe(0);
  });
});