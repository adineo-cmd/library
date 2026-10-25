/**
 * Fetch the academic-discipline taxonomy from Wikidata and cache it under
 * atlas-work/.
 *
 * The Wikipedia category graph proved unusable as a *hierarchy*: 23,145 of
 * its 30,041 emitted nodes are roots because maintenance hubs own the real
 * parents. Wikidata's `subclass of` (P279) tree under Q11862829 (academic
 * discipline) is a curated ~9,700-node DAG with clean parentage, so it
 * becomes the structural spine of the atlas. Wikipedia categories remain in
 * the repo as the deep-browse layer, but nothing in the site structure
 * derives from them.
 *
 * Three queries, all cached:
 *   1. edges     — every (child, parent) P279 edge where both ends sit in
 *                  the discipline subtree. Multi-parent edges are kept; the
 *                  primary-parent rule resolves them at build time.
 *   2. top level — the direct children of the root, which the edges query
 *                  misses (their parent is the root itself).
 *   3. labels    — label, description and English Wikipedia sitelink for
 *                  every item, fetched in VALUES batches.
 *
 * A missing or empty cache triggers a refetch; the script is idempotent.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = resolve(ROOT, 'atlas-work');
const EDGES_CACHE = resolve(WORK, 'wikidata-edges.json');
const LABELS_CACHE = resolve(WORK, 'wikidata-labels.json');

const ENDPOINT = 'https://query.wikidata.org/sparql';
const AGENT = 'arbor-atlas/1.0 (https://github.com/adineo-cmd/memex; educational atlas)';
const DISCIPLINE = 'wd:Q11862829';
const BATCH = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sparql(query, { tries = 5 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': AGENT },
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = attempt * 15_000;
        console.log(`  endpoint busy (${res.status}), waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`SPARQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()).results.bindings;
    } catch (e) {
      // The endpoint drops long-running sockets under load; a retry after a
      // short backoff has always reconnected so far.
      if (attempt === tries) throw e;
      const wait = attempt * 10_000;
      console.log(`  fetch error (${e.message}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error('SPARQL: retries exhausted');
}

const qid = (uri) => (uri?.value ? uri.value.split('/').pop() : null);

/** Every item inside the discipline subtree, one column — small response. */
async function fetchItems() {
  const rows = await sparql(`
    SELECT ?item WHERE { ?item wdt:P279+ ${DISCIPLINE} . }`);
  const items = rows.map(r => qid(r.item)).filter(Boolean);
  if (!items.length && rows.length) {
    console.error('  diagnose first row:', JSON.stringify(rows[0]).slice(0, 300));
  }
  console.log(`  items: ${items.length} (${rows.length - items.length} malformed rows skipped)`);
  return items;
}

/**
 * Every P279 edge with both ends inside the discipline subtree, fetched in
 * VALUES batches. The single monolithic query returns a ~28 MB JSON body that
 * the endpoint truncates mid-JSON (it died at the same byte offset on every
 * retry), so the work is split into ~400-item requests whose responses are
 * small enough to always arrive complete.
 */
async function fetchEdges(items) {
  const inTree = new Set(items);
  const edges = [];
  const batches = Math.ceil(items.length / BATCH);
  for (let b = 0; b < batches; b++) {
    const chunk = items.slice(b * BATCH, (b + 1) * BATCH);
    const values = chunk.map(q => `wd:${q}`).join(' ');
    try {
      const rows = await sparql(`
        SELECT ?item ?parent WHERE {
          VALUES ?item { ${values} }
          ?item wdt:P279 ?parent .
          ?parent wdt:P279+ ${DISCIPLINE} .
        }`);
      for (const r of rows) {
        const child = qid(r.item), parent = qid(r.parent);
        // Edges to the root itself are the top level, handled separately.
        if (inTree.has(parent)) edges.push({ child, parent });
      }
    } catch (e) {
      console.warn(`  edge batch ${b + 1}/${batches} failed: ${e.message}`);
    }
    if ((b + 1) % 10 === 0) console.log(`  ${b + 1}/${batches} edge batches, ${edges.length} edges`);
    await sleep(600);
  }
  console.log(`  edges: ${edges.length}`);
  return edges;
}

/** Direct children of the root itself — the top level of the taxonomy. */
async function fetchTopLevel() {
  const rows = await sparql(`
    SELECT ?item WHERE { ?item wdt:P279 ${DISCIPLINE} . }`);
  const items = rows.map(r => qid(r.item)).filter(Boolean);
  console.log(`  top level: ${items.length}`);
  return items;
}

/** Label + description + enwiki sitelink via wbgetentities — the MediaWiki
 *  action API, which serves 50 ids per request in about a second. The SPARQL
 *  equivalent (label service + sitelink join over VALUES batches) timed out
 *  on ~78% of batches, so this is not a micro-optimisation, it is the only
 *  path that actually completes. */
async function fetchLabelBatch(qids) {
  const out = [];
  const SUB = 50;
  for (let i = 0; i < qids.length; i += SUB) {
    const chunk = qids.slice(i, i + SUB);
    const url = 'https://www.wikidata.org/w/api.php?' + new URLSearchParams({
      action: 'wbgetentities',
      ids: chunk.join('|'),
      props: 'labels|descriptions|sitelinks',
      languages: 'en',
      sitefilter: 'enwiki',
      format: 'json',
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': AGENT },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`wbgetentities ${res.status}`);
        const j = await res.json();
        for (const q of chunk) {
          const e = j.entities?.[q];
          if (!e) continue;
          out.push({
            item: { value: `http://www.wikidata.org/entity/${q}` },
            itemLabel: { value: e.labels?.en?.value ?? q },
            itemDescription: { value: e.descriptions?.en?.value ?? null },
            article: e.sitelinks?.enwiki?.title
              ? { value: `https://en.wikipedia.org/wiki/${e.sitelinks.enwiki.title}` }
              : null,
          });
        }
        break;
      } catch (e) {
        if (attempt === 4) { console.warn(`  wbgetentities chunk failed: ${e.message}`); }
        else await sleep(attempt * 4000);
      }
    }
    await sleep(250);
  }
  return out;
}

async function main() {
  mkdirSync(WORK, { recursive: true });

  let edges, top;
  if (existsSync(EDGES_CACHE)) {
    ({ edges, top } = JSON.parse(readFileSync(EDGES_CACHE, 'utf8')));
    console.log(`edges cached: ${edges.length}, top: ${top.length}`);
  } else {
    console.log('fetching edges…');
    const items = await fetchItems();
    edges = await fetchEdges(items);
    top = await fetchTopLevel();
    writeFileSync(EDGES_CACHE, JSON.stringify({ edges, top }));
  }

  // The item set: every node named by an edge, plus the root's children.
  const items = new Set(top);
  for (const e of edges) { items.add(e.child); items.add(e.parent); }

  let labels = existsSync(LABELS_CACHE)
    ? JSON.parse(readFileSync(LABELS_CACHE, 'utf8'))
    : {};

  // Merge mode: only qids absent from the cache are requested, and a failed
  // batch leaves its qids absent rather than writing a poison-pill fallback —
  // an entry whose label is the bare qid would otherwise be cached forever.
  // A rerun then retries exactly what is missing.
  const qids = [...items].filter(q => !labels[q]);
  if (qids.length) {
    console.log(`fetching labels for ${qids.length} items in batches of ${BATCH}…`);
    const batches = Math.ceil(qids.length / BATCH);
    let failed = 0;
    for (let b = 0; b < batches; b++) {
      const chunk = qids.slice(b * BATCH, (b + 1) * BATCH);
      try {
        for (const r of await fetchLabelBatch(chunk)) {
          const q = qid(r.item);
          if (!q || labels[q]) continue;
          labels[q] = {
            label: r.itemLabel?.value ?? q,
            description: r.itemDescription?.value ?? null,
            wiki: r.article?.value
              ? r.article.value.replace('https://en.wikipedia.org/wiki/', '')
              : null,
          };
        }
      } catch (e) {
        failed += chunk.length;
        console.warn(`  batch ${b + 1}/${batches} failed: ${e.message}`);
      }
      if ((b + 1) % 5 === 0) console.log(`  ${b + 1}/${batches} batches`);
      writeFileSync(LABELS_CACHE, JSON.stringify(labels));
      await sleep(700);
    }
    console.log(`  label pass: ${failed} qids failed and will retry on the next run`);
  }

  const unlabeled = [...items].filter(q => !labels[q]).length;
  console.log(`done — ${items.size} items, ${edges.length} edges, ${unlabeled} unlabeled`);
}

main().catch(e => { console.error(e); process.exit(1); });
