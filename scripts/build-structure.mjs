/**
 * Build the site spine: public/data/artifacts/structure.json (+ layout).
 *
 * Inputs: scripts/spine.mjs (the curated 8-trunk structure) and the Wikidata
 * discipline pool (atlas-work/wikidata-{edges,labels}.json, ~9.7k fields with
 * clean labels, descriptions and Wikipedia links).
 *
 * Every discipline is classified by the spine's keyword regexes — subdomain
 * keywords win over domain keywords — and hangs off its bucket in a
 * mini-hierarchy: a discipline whose Wikidata parent landed in the same
 * bucket keeps that parent, everything else attaches to the bucket itself.
 * Unmatched disciplines fall into their trunk's auto-created "Other fields"
 * bucket; a discipline whose trunk itself is unclear goes under a final
 * Interdisciplinary trunk. Nothing is dropped.
 *
 * Output (one fetch for every view):
 *   nodes  [{ id, name, description, wiki, parent, depth, size, trunk, kind }]
 *   trunks [{ id, name, num, color }]
 *   xlinks [[a, b]]            — Wikidata multi-parent edges, node indices
 *   taxonomy-layout.bin         — Float32 x/y, precomputed force layout
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from 'd3-force';
import { SPINE, GENERAL_TRUNK } from './spine.mjs';
import { fieldScore, spineScore } from './popularity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = resolve(ROOT, 'atlas-work');
const OUT = resolve(ROOT, 'public/data/artifacts');

/**
 * Give every spine node a Wikipedia sitelink by asking enwiki whether an
 * article with that exact title exists (redirects resolved, disambiguation
 * pages rejected). Cached in atlas-work/spine-wiki.json so reruns stay
 * offline-fast; ~500 titles is ~13 batched API calls.
 */
async function fillSpineWiki(nodes) {
  // v2 cache entries are { w: article title, q: wikidata qid | null } — the
  // qid lets the popularity pass measure spine nodes through Wikidata
  // sitelinks instead of the rate-limited langlinks endpoint.
  const cachePath = resolve(WORK, 'spine-wiki2.json');
  const map = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const missing = [...new Set(nodes
    .filter(n => !n.wiki && n.kind !== 'field')
    .map(n => n.name))]
    .filter(t => !(t in map));
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 40) {
      const chunk = missing.slice(i, i + 40);
      const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
        action: 'query', format: 'json', titles: chunk.join('|'),
        redirects: '1', prop: 'pageprops',
      });
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'library/1.0 (educational atlas)' },
          signal: AbortSignal.timeout(30_000),
        });
        const j = await res.json();
        const q = j.query ?? {};
        const norm = new Map((q.normalized ?? []).map(x => [x.from, x.to]));
        const redir = new Map((q.redirects ?? []).map(x => [x.from, x.to]));
        const canon = (t) => redir.get(norm.get(t) ?? t) ?? (norm.get(t) ?? t);
        const pages = Object.values(q.pages ?? {}).filter(p => p.pageid > 0);
        const liveTitle = new Map(pages
          .filter(p => !p.pageprops?.disambiguation)
          .map(p => [p.title, p.pageprops?.wikibase_item ?? null]));
        for (const t of chunk) {
          const c = canon(t);
          map[t] = liveTitle.has(c)
            ? { w: c.replace(/ /g, '_'), q: liveTitle.get(c) }
            : null;
        }
      } catch (e) {
        console.warn(`  wiki-fill batch failed: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    writeFileSync(cachePath, JSON.stringify(map));
  }
  for (const n of nodes) {
    if (n.wiki || n.kind === 'field') continue;
    const hit = map[n.name];
    if (!hit) continue;
    n.wiki = hit.w;
    if (hit.q) n.qid = hit.q;
  }
}

// Which trunk each Wikidata root feeds. Disciplines are assigned by keyword
// (they spread across the academic trunks); sport and game items belong to
// Sports & Games; crafts and occupations to Trades & Crafts.
const ROOT_TRUNK = {
  sports: 'sports',
  games: 'sports',
  crafts: 'trades',
  occupations: 'trades',
};

async function main() {
  const edgeFile = JSON.parse(readFileSync(resolve(WORK, 'wikidata-edges.json'), 'utf8'));
  const { edges } = edgeFile;
  const provenance = edgeFile.provenance ?? {};
  const labels = JSON.parse(readFileSync(resolve(WORK, 'wikidata-labels.json'), 'utf8'));

  // ---- spine nodes ----------------------------------------------------------
  const nodes = [];
  const spineIndex = new Map(); // spine id -> node index
  const trunkIdx = new Map();   // trunk id -> trunk number

  SPINE.forEach((trunk, ti) => {
    trunkIdx.set(trunk.id, ti);
    nodes.push({ id: `trunk:${trunk.id}`, name: trunk.name, description: trunk.blurb,
      wiki: null, parent: -1, trunk: ti, kind: 'trunk' });
    const tI = nodes.length - 1;
    for (const domain of trunk.domains) {
      nodes.push({ id: `domain:${trunk.id}/${domain.id}`, name: domain.name,
        description: domain.blurb, wiki: null, parent: tI, trunk: ti, kind: 'domain' });
      const dI = nodes.length - 1;
      spineIndex.set(`${trunk.id}/${domain.id}`, dI);
      for (const sub of domain.subs ?? []) {
        nodes.push({ id: `sub:${trunk.id}/${domain.id}/${sub.id}`, name: sub.name,
          description: null, wiki: null, parent: dI, trunk: ti, kind: 'subdomain' });
        spineIndex.set(`${trunk.id}/${domain.id}/${sub.id}`, nodes.length - 1);
      }
    }
  });
  trunkIdx.set(GENERAL_TRUNK.id, SPINE.length);
  nodes.push({ id: `trunk:${GENERAL_TRUNK.id}`, name: GENERAL_TRUNK.name,
    description: GENERAL_TRUNK.blurb, wiki: null, parent: -1,
    trunk: SPINE.length, kind: 'trunk' });

  // auto "Other fields" bucket per trunk
  const otherBucket = new Map(); // trunk number -> node index
  SPINE.forEach((trunk, ti) => {
    nodes.push({ id: `other:${trunk.id}`, name: `Other ${trunk.name} Fields`,
      description: `Disciplines of ${trunk.name} not yet placed under a domain.`,
      wiki: null, parent: nodes.findIndex(n => n.id === `trunk:${trunk.id}`),
      trunk: ti, kind: 'domain' });
    otherBucket.set(ti, nodes.length - 1);
  });
  nodes.push({ id: 'other:general', name: 'Unclassified Fields',
    description: 'Disciplines still waiting for a home in the atlas.',
    wiki: null, parent: nodes.length - 1 - nodes.slice().reverse().findIndex(n => n.id === 'trunk:general'),
    trunk: SPINE.length, kind: 'domain' });
  otherBucket.set(SPINE.length, nodes.length - 1);

  // ---- classify the Wikidata pool -------------------------------------------
  const pool = new Map(); // qid -> { label, description, wiki }
  for (const [q, v] of Object.entries(labels)) {
    if (v.label && v.label !== q) pool.set(q, v);
  }
  const qids = [...pool.keys()];

  // Wikidata parent for mini-hierarchy inside buckets. After classification,
  // a child prefers a parent that landed in the SAME bucket — that is the
  // chain the atlas will honour — and falls back to its first Wikidata edge.
  const classify = (qid) => {
    const text = `${pool.get(qid).label}`;
    for (let ti = 0; ti < SPINE.length; ti++) {
      for (const domain of SPINE[ti].domains) {
        for (const sub of domain.subs ?? []) {
          if (sub.kw.test(text)) return { bucket: `${SPINE[ti].id}/${domain.id}/${sub.id}` };
        }
      }
    }
    for (let ti = 0; ti < SPINE.length; ti++) {
      for (const domain of SPINE[ti].domains) {
        if (domain.kw.test(text)) return { bucket: `${SPINE[ti].id}/${domain.id}` };
      }
    }
    return null;
  };

  // Two passes: place everything, then pull children under same-bucket parents.
  const firstPass = new Map(); // qid -> node index
  for (const qid of qids) {
    const hit = classify(qid);
    if (!hit) continue;
    firstPass.set(qid, spineIndex.get(hit.bucket));
  }

  // Wikidata parent for the mini-hierarchy. After classification, a child
  // prefers a parent that landed in the SAME bucket — that is the chain the
  // atlas will honour — and falls back to its first Wikidata edge.
  const allParents = new Map();
  for (const { child, parent } of edges) {
    if (!allParents.has(child)) allParents.set(child, []);
    allParents.get(child).push(parent);
  }
  const wdParents = new Map();
  for (const qid of qids) {
    const cands = (allParents.get(qid) ?? []).filter(p => pool.has(p));
    const sameBucket = cands.find(p => firstPass.has(p) && firstPass.get(p) === firstPass.get(qid));
    wdParents.set(qid, sameBucket ?? cands[0] ?? null);
  }

  const placed = new Map(); // qid -> parent node index
  for (const qid of qids) {
    if (firstPass.has(qid)) { placed.set(qid, firstPass.get(qid)); continue; }
    // No keyword hit — ancestry decides: which Wikidata root the item
    // descends from, then the parent's placement, then "general".
    const p = wdParents.get(qid);
    const roots = provenance[qid] ?? [];
    const rootTrunk = roots.map(r => ROOT_TRUNK[r]).find(t => t != null);
    if (rootTrunk != null) {
      placed.set(qid, otherBucket.get(trunkIdx.get(rootTrunk)));
      continue;
    }
    const pNode = p != null && placed.has(p) ? placed.get(p) : null;
    if (pNode != null) {
      placed.set(qid, otherBucket.get(nodes[pNode].trunk));
    } else {
      placed.set(qid, otherBucket.get(SPINE.length));
    }
  }
  // Parents may be placed after their children on the first sweep; a second
  // pass catches the stragglers whose trunk was still unknown.
  for (const qid of qids) {
    if (firstPass.has(qid)) continue;
    if (nodes[placed.get(qid)]?.trunk !== SPINE.length) continue;
    const roots = provenance[qid] ?? [];
    const rootTrunk = roots.map(r => ROOT_TRUNK[r]).find(t => t != null);
    if (rootTrunk != null) { placed.set(qid, otherBucket.get(trunkIdx.get(rootTrunk))); continue; }
    const p = wdParents.get(qid);
    const pNode = p != null && placed.has(p) ? placed.get(p) : null;
    if (pNode != null) placed.set(qid, otherBucket.get(nodes[pNode].trunk));
  }

  // Mini-hierarchy: within a bucket, a discipline attaches to the DEEPEST
  // Wikidata ancestor that landed in the same bucket — so real sub-structure
  // (behavioural finance under behavioural economics) survives, while chains
  // that would cross trunk boundaries are flattened onto the bucket itself.
  // Shortest chains are resolved first so deep chains inherit their parents'
  // placements.
  const wdAncestors = (qid) => {
    const chain = [];
    let cur = wdParents.get(qid);
    const guard = new Set([qid]);
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      cur = wdParents.get(cur);
    }
    return chain;
  };
  const byChainLen = [...qids].sort((a, b) =>
    wdAncestors(a).length - wdAncestors(b).length || a.localeCompare(b));
  // Pool node indices are deterministic: pool nodes are appended in `qids`
  // order, right after the spine. Precompute so a child can name its parent.
  const poolIndex = new Map(qids.map((q, i) => [q, nodes.length + i]));
  for (const qid of byChainLen) {
    if (!firstPass.has(qid)) continue;
    const bucket = firstPass.get(qid);
    // Nearest same-bucket ancestor becomes the parent; the bucket node itself
    // is the fallback. Chains therefore deepen within a bucket and stop at
    // its boundary.
    let attach = bucket;
    for (const anc of wdAncestors(qid)) {
      if (anc === qid) break;
      if (firstPass.get(anc) === bucket) { attach = poolIndex.get(anc); break; }
    }
    placed.set(qid, attach);
  }

  const qidIndex = new Map();
  for (const qid of qids) {
    const l = pool.get(qid);
    // A placement may point at another pool node that is not pushed yet, so
    // the trunk comes from the classification bucket — a spine node that
    // already exists — rather than from the parent.
    const bucketIdx = firstPass.get(qid) ?? placed.get(qid);
    nodes.push({ id: qid, name: l.label, description: l.description ?? null,
      wiki: l.wiki ?? null, parent: placed.get(qid),
      trunk: nodes[bucketIdx]?.trunk ?? SPINE.length, kind: 'field',
      pop: 0 });
    qidIndex.set(qid, nodes.length - 1);
  }

  // Borrow qids onto spine nodes by label first, so the popularity pass
  // measures them through Wikidata where possible.
  {
    const byLabel = new Map();
    for (const [q, l] of pool) byLabel.set(l.label.toLowerCase(), { ...l, qid: q });
    for (const n of nodes) {
      if (n.kind === 'field' || n.qid) continue;
      const hit = byLabel.get(n.name.toLowerCase());
      if (hit?.qid) n.qid = hit.qid;
    }
  }

  await fillSpineWiki(nodes);

  // ---- popularity: hand knowledge, zero network --------------------------------
  // The score is: curated spine position (famous-first by construction) over
  // a famous-terms bonus for pool fields, with the sitelink counts already
  // cached from earlier builds as a small local tie-breaker. No requests.
  function scorePopularity(nodes) {
    let cache = {};
    const cachePath = resolve(WORK, 'sitelinks.json');
    if (existsSync(cachePath)) {
      try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
    }
    // A spine node's rank is its position in the spine's curated lists —
    // spine.mjs was written famous-first, so declaration order IS the
    // ranking. Node-array order would leak the wine-flood sizes into it.
    const orderIdx = new Map();
    SPINE.forEach((trunk) => {
      trunk.domains.forEach((d, di) => {
        orderIdx.set(`domain:${trunk.id}/${d.id}`, di);
        (d.subs ?? []).forEach((s, si) => orderIdx.set(`sub:${trunk.id}/${d.id}/${s.id}`, si));
      });
    });
    for (const n of nodes) {
      const sitelinks = (n.qid ? cache[n.qid] : undefined)
        ?? (n.wiki ? cache['_t:' + n.wiki] : undefined) ?? 0;
      if (n.kind === 'field') {
        n.pop = Math.round(fieldScore(n.name, sitelinks));
      } else if (orderIdx.has(n.id)) {
        // the curated position IS the rank — no bonus here, or measured
        // sitelink counts would shuffle the hand ordering
        n.pop = spineScore(n.kind, orderIdx.get(n.id));
      } else {
        // catch-all buckets ("Other X Fields") — uncurated leftovers sink
        n.pop = 120;
      }
    }
  }
  scorePopularity(nodes);

  // ---- spine sitelinks ---------------------------------------------------------
  // Many curated domains and subdomains exist verbatim in the Wikidata pool
  // ("Quantum Mechanics" ↔ quantum mechanics). Borrow their Wikipedia
  // sitelinks so every node in the atlas can answer "what is this" with a
  // real article, not just the pool's leaf fields.
  {
    const byLabel = new Map();
    for (const [q, l] of pool) byLabel.set(l.label.toLowerCase(), { ...l, qid: q });
    for (const n of nodes) {
      if (n.kind === 'field' || n.wiki) continue;
      const hit = byLabel.get(n.name.toLowerCase());
      if (hit?.wiki) n.wiki = hit.wiki;
      if (hit?.qid) n.qid = hit.qid;
    }
  }

  // ---- the Wikipedia layer -----------------------------------------------------
  // The Wikidata roots give clean structure; the 1.1M Wikipedia categories
  // (already ingested locally from the wiki dumps) give the long tail — every
  // sport, game, craft, trade and hobby with a category on the wiki. They
  // arrive as a flat classified layer: keyword gate first (a category that
  // matches no domain keyword is content, not a field, and is dropped), then
  // per-bucket caps by article count, then dedupe against every name already
  // in the atlas. Categories carry no hierarchy of their own — that is what
  // the spine provides.
  {
    const wpPath = resolve(WORK, 'wp-categories.json');
    if (existsSync(wpPath)) {
      console.log('classifying the Wikipedia category pool…');
      const wpCats = JSON.parse(readFileSync(wpPath, 'utf8'));
      const WP_JUNK = [
        / articles?$/i, / lists?$/i, / stubs?$/i, /^lists? of /i,
        /\b(articles|pages|categories|templates|navalboxes)\b/i,
        /\b(people|actors|actresses|players|footballers|musicians|singers|writers|artists|politicians|scientists|children|men|women|males|females|families|dynasties)\b/i,
        /\b(films|albums|songs|novels|television series|tv series|books|comics|anime|manga|video games|board games|card games|magazines|newspapers)\b/i,
        /\b(stubs|redirects|images|photographs|screenshots)\b/i,
        /\b(19|20)\d\d(s)?\b (in|by) /i,
        / (by|in) (country|countries|state|states|city|cities|county|province|region|continent)$/i,
        /^\d{4}/, /\b(draft|wikiproject|user)\b/i,
      ];
      const knownNames = new Set(nodes.map(n => n.name.toLowerCase()));
      const buckets = new Map(); // bucket idx -> [{name, articles}]
      let matched = 0;
      for (const { name, articles } of wpCats) {
        if (matched >= 400000) break;
        if (WP_JUNK.some(re => re.test(name))) continue;
        const lower = name.toLowerCase();
        if (knownNames.has(lower)) continue;
        // subdomain keywords first — the more specific bucket wins
        let placed = false;
        for (let ti = 0; ti < SPINE.length && !placed; ti++) {
          for (const domain of SPINE[ti].domains) {
            for (const sub of domain.subs ?? []) {
              if (sub.kw.test(name)) {
                const b = spineIndex.get(`${SPINE[ti].id}/${domain.id}/${sub.id}`);
                if (!buckets.has(b)) buckets.set(b, []);
                buckets.get(b).push({ name, articles });
                placed = true;
                break;
              }
            }
            if (placed) break;
            if (domain.kw.test(name)) {
              const b = spineIndex.get(`${SPINE[ti].id}/${domain.id}`);
              if (!buckets.has(b)) buckets.set(b, []);
              buckets.get(b).push({ name, articles });
              placed = true;
              break;
            }
          }
        }
        if (placed) { matched++; knownNames.add(lower); }
      }
      // caps: a bucket that swallowed 500 categories of one shape is a
      // flood, not a curriculum
      const CAP_SUB = 60, CAP_DOMAIN = 40;
      let added = 0;
      const wpNodes = [];
      for (const [b, list] of buckets) {
        const isSub = nodes[b].kind === 'subdomain';
        const cap = isSub ? CAP_SUB : CAP_DOMAIN;
        list.sort((x, y) => y.articles - x.articles);
        for (const { name, articles } of list.slice(0, cap)) {
          wpNodes.push({
            id: `wp:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            name, description: null,
            wiki: name.replace(/ /g, '_'),
            parent: b, trunk: nodes[b].trunk, kind: 'field',
            size: 1, depth: (nodes[b].depth ?? 0) + 1,
            pop: Math.round(fieldScore(name, Math.min(articles, 150))),
          });
          added++;
        }
      }
      // sizes/depths recompute later; wire parents now
      for (const n of wpNodes) nodes.push(n);
      console.log(`wikipedia pool: ${matched} matched, ${added} placed across ${buckets.size} buckets`);
    }
  }

  // ---- sizes and depths ------------------------------------------------------
  const kidsOf = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parent;
    if (p >= 0) {
      if (!kidsOf.has(p)) kidsOf.set(p, []);
      kidsOf.get(p).push(i);
    }
  }
  const sizeOf = new Int32Array(nodes.length).fill(1);
  {
    const post = [];
    const seen = new Uint8Array(nodes.length);
    const stack = [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].parent === -1) stack.push(i);
    }
    while (stack.length) {
      const i = stack[stack.length - 1];
      if (!seen[i]) {
        seen[i] = 1;
        for (const k of kidsOf.get(i) ?? []) if (!seen[k]) stack.push(k);
      } else {
        stack.pop();
        let s = 1;
        for (const k of kidsOf.get(i) ?? []) s += sizeOf[k];
        sizeOf[i] = s;
        post.push(i);
      }
    }
  }
  const depthOf = new Int32Array(nodes.length);
  {
    const queue = nodes.map((n, i) => (n.parent === -1 ? i : null)).filter(i => i != null);
    for (const i of queue) depthOf[i] = 0;
    while (queue.length) {
      const i = queue.shift();
      for (const k of kidsOf.get(i) ?? []) { depthOf[k] = depthOf[i] + 1; queue.push(k); }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].size = sizeOf[i];
    nodes[i].depth = depthOf[i];
  }

  // ---- crosslinks: Wikidata multi-parent edges between placed nodes ----------
  const xlinks = [];
  const seenPair = new Set();
  for (const { child, parent } of edges) {
    const a = qidIndex.get(child), b = qidIndex.get(parent);
    if (a == null || b == null) continue;
    if (nodes[a].parent === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    xlinks.push([a, b]);
  }

  // ---- precomputed force layout ----------------------------------------------
  // Spine nodes are pinned near their trunk so the pool arranges around a
  // legible skeleton rather than a random cloud.
  console.log('computing force layout…');
  const xs = new Float32Array(nodes.length);
  const ys = new Float32Array(nodes.length);
  {
    const simNodes = nodes.map((n, i) => ({
      index: i,
      // heavier spine nodes hold their ground against the pool
      r: n.kind === 'field' ? 3 : 10,
    }));
    const links = [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].parent >= 0) links.push({ source: i, target: nodes[i].parent, dist: 24 });
    }
    for (const [a, b] of xlinks) links.push({ source: a, target: b, dist: 60 });

    // Trunk roots are pinned to points on a ring — one sector per trunk — so
    // the finished constellation reads as distinct clusters rather than one
    // merged blob. Fields start near their trunk's sector and settle around
    // their pinned skeleton.
    let sseed = 7;
    const rnd = () => { sseed = (sseed * 1103515245 + 12345) & 0x7fffffff; return sseed / 0x7fffffff; };
    const RING = 340;
    for (const n of simNodes) {
      const trunk = nodes[n.index].trunk;
      const trunkCount = SPINE.length + 1;
      const ang = (trunk / trunkCount) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      const kind = nodes[n.index].kind;
      if (kind === 'trunk') {
        n.x = Math.cos(ang) * RING; n.y = Math.sin(ang) * RING;
        n.fx = n.x; n.fy = n.y;
      } else if (kind === 'domain') {
        // Domains pinned nearer their trunk: the skeleton of each cluster is
        // then fully rigid, and fields settle around it.
        const rad = RING * (0.55 + rnd() * 0.25);
        n.x = Math.cos(ang) * rad; n.y = Math.sin(ang) * rad;
        n.fx = n.x; n.fy = n.y;
      } else {
        const rad = RING * (0.4 + rnd() * 0.6);
        n.x = Math.cos(ang) * rad; n.y = Math.sin(ang) * rad;
      }
    }
    const sim = forceSimulation(simNodes)
      .force('charge', forceManyBody().strength(-38))
      .force('link', forceLink(links).distance(d => d.dist).strength(0.35))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide(d => d.r))
      .stop();
    for (let i = 0; i < 220; i++) sim.tick();
    for (const n of simNodes) { xs[n.index] = n.x; ys[n.index] = n.y; }
  }
  console.log('layout done');

  // ---- emit -------------------------------------------------------------------
  const trunks = [...SPINE.map(t => ({ id: t.id, name: t.name, color: t.color })),
    { id: GENERAL_TRUNK.id, name: GENERAL_TRUNK.name, color: GENERAL_TRUNK.color }];

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'structure.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'Wikidata academic-discipline subtree (P279 of Q11862829), curated spine in scripts/spine.mjs',
    nodeCount: nodes.length,
    trunks,
    nodes,
    xlinks,
  }));
  const layoutBuf = Buffer.alloc(nodes.length * 8);
  const f32 = new Float32Array(layoutBuf.buffer);
  f32.set(xs, 0);
  f32.set(ys, nodes.length);
  writeFileSync(resolve(OUT, 'taxonomy-layout.bin'), layoutBuf);

  console.log(`nodes: ${nodes.length} (spine ${nodes.length - qids.length}, pool ${qids.length}), xlinks: ${xlinks.length}`);
  for (let ti = 0; ti < trunks.length; ti++) {
    const count = nodes.filter(n => n.trunk === ti && n.kind === 'field').length;
    console.log(`  ${trunks[ti].name.padEnd(26)} fields=${count}`);
  }
}

main();
