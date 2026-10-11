import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

/**
 * Longest `INSERT INTO `t` VALUES` header is well under this. A header whose
 * tail is retained is short enough that the next chunk always completes it.
 */
const HEADER_TAIL = 128;

/** mysqldump caps extended INSERTs near 1 MB; this is a runaway backstop. */
const MAX_STATEMENT = 64 * 1024 * 1024;

/** Header bytes to scan before reporting that a dump declares no schema. */
const SCHEMA_SCAN_BYTES = 8 * 1024 * 1024;

/** Split one VALUES tuple into field strings. Unquoted NULL becomes ''. */
export function splitTuple(tuple) {
  const out = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  let inStr = false;
  while (i < tuple.length) {
    const ch = tuple[i];
    if (inStr) {
      if (ch === '\\') { cur += tuple[i + 1] ?? ''; i += 2; continue; }
      if (ch === "'" && tuple[i + 1] === "'") { cur += "'"; i += 2; continue; }
      if (ch === "'") { inStr = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === "'") { inStr = true; quoted = true; i++; continue; }
    if (ch === ',') { out.push(!quoted && cur === 'NULL' ? '' : cur); cur = ''; quoted = false; i++; continue; }
    cur += ch; i++;
  }
  out.push(!quoted && cur === 'NULL' ? '' : cur);
  return out;
}

/** Yield each VALUES tuple body within a single INSERT statement. */
export function* splitTuples(body) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'" && body[i + 1] === "'") { i += 2; continue; }
      if (ch === "'") inStr = false;
      i++; continue;
    }
    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === '(') { if (depth === 0) start = i + 1; depth++; i++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) { yield body.slice(start, i); start = -1; }
      i++; continue;
    }
    i++;
  }
}

/**
 * Read a gzipped SQL dump and hand every INSERT row to `onRow(table, fields)`.
 *
 * `onRow` must be synchronous. The real categorylinks dump holds well over a
 * hundred million rows; awaiting per row would be untenable, so callers batch
 * writes inside a transaction instead.
 *
 * At most one statement is buffered. Chunks arrive on arbitrary 16 KB seams,
 * so both the header search and the statement terminator search carry state
 * across calls: the search resumes where it stopped rather than rescanning.
 *
 * `options.maxStatement` overrides the runaway backstop; it exists so the guard
 * can be tested without materialising 64 MB.
 */
export async function streamInsertRows(filePath, onRow, options = {}) {
  const maxStatement = options.maxStatement ?? MAX_STATEMENT;
  const decoder = new StringDecoder('utf8');
  const insertRe = /INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s+VALUES/gi;

  let table = null;
  let pending = '';   // text not yet attributed to a statement
  let body = '';      // the statement being assembled
  let scanPos = 0;    // how far `body` has been searched for a terminator
  let inStr = false;  // quote state at `scanPos`

  /**
   * Index of the next `;` outside a string literal, or -1. Resumable: the scan
   * restarts at `scanPos`, so each character of the file is read once no matter
   * how many chunks the statement spans.
   */
  const findTerminator = () => {
    for (let i = scanPos; i < body.length; i++) {
      const ch = body[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === "'" && body[i + 1] === "'") { i++; continue; }
        if (ch === "'") inStr = false;
        continue;
      }
      if (ch === "'") { inStr = true; continue; }
      if (ch === ';') { scanPos = i + 1; inStr = false; return i; }
    }
    scanPos = body.length;
    return -1;
  };

  const drain = () => {
    for (;;) {
      if (table === null) {
        insertRe.lastIndex = 0;
        const m = insertRe.exec(pending);
        if (m === null) {
          // Keep only enough tail for a header split across the next chunk.
          if (pending.length > HEADER_TAIL) pending = pending.slice(-HEADER_TAIL);
          return;
        }
        table = m[1];
        body = pending.slice(m.index + m[0].length);
        pending = '';
      } else {
        // Mid-statement: everything that has arrived belongs to `body`.
        body += pending;
        pending = '';
      }

      const semi = findTerminator();
      if (semi === -1) {
        if (body.length > maxStatement) {
          throw new Error(`INSERT into ${table} exceeded ${maxStatement} bytes without a terminator`);
        }
        return;
      }

      const stmt = body.slice(0, semi);
      body = body.slice(semi + 1);
      pending = body;
      body = '';
      scanPos = 0;
      inStr = false;

      const name = table;
      table = null;
      for (const tuple of splitTuples(stmt)) onRow(name, splitTuple(tuple));
    }
  };

  await new Promise((resolve, reject) => {
    const src = createReadStream(filePath).pipe(createGunzip());
    src.on('data', chunk => {
      try {
        pending += decoder.write(chunk);
        drain();
      } catch (err) {
        src.destroy();
        reject(err);
      }
    });
    src.on('error', reject);
    src.on('end', () => {
      try {
        pending += decoder.end();
        drain();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Read the CREATE TABLE declarations from the head of a gzipped dump.
 *
 * Column order differs between dump vintages, so callers resolve fields by name
 * instead of hardcoding positions. Returns Map<tableName, columnNames[]> for
 * every table declared within the scanned prefix.
 */
export async function readDumpSchema(filePath, maxBytes = SCHEMA_SCAN_BYTES) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;

  await new Promise((resolve, reject) => {
    const src = createReadStream(filePath).pipe(createGunzip());
    src.on('data', chunk => {
      bytes += chunk.length;
      text += decoder.write(chunk);
      if (bytes >= maxBytes) src.destroy();
    });
    src.on('error', err => {
      // Destroying mid-stream surfaces as a premature close; the bytes read so
      // far are all this function needs.
      if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') resolve();
      else reject(err);
    });
    src.on('end', () => { text += decoder.end(); resolve(); });
    src.on('close', resolve);
  });

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\(/gi;
  const schema = new Map();
  for (let m = createRe.exec(text); m !== null; m = createRe.exec(text)) {
    const columns = readColumnList(text, m.index + m[0].length);
    if (columns.length) schema.set(m[1], columns);
  }
  return schema;
}

/** Column names from the parenthesised body of a CREATE TABLE, constraints dropped. */
function readColumnList(text, start) {
  let depth = 1;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return splitDefinitions(text.slice(start, i));
    }
  }
  return [];
}

/** Split a CREATE TABLE body on top-level commas and keep the column definitions. */
function splitDefinitions(inner) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (ch === ',' && depth === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
  }
  parts.push(inner.slice(from));

  // mysqldump backquotes every column and never backquotes a constraint name,
  // which is what keeps PRIMARY KEY / UNIQUE KEY lines out of the result.
  return parts
    .map(p => /^\s*`([A-Za-z_][A-Za-z0-9_]*)`/.exec(p))
    .filter(Boolean)
    .map(m => m[1]);
}