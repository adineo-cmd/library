/**
 * Build public/data/artifacts/roadmaps.json — a roadmap.sh-style learning
 * path for every domain in the taxonomy that has enough children to be worth
 * one.
 *
 * A roadmap is a small node-link diagram: the children of one node, ordered
 * foundation-first (largest subtree first — the bigger a subfield's subtree,
 * the more general it is), grouped into rows top-to-bottom, connected by a
 * spine so the eye reads it as a path rather than a list. Crosslink
 * neighbours of the roadmap's node appear as dotted optional side-nodes, the
 * way roadmap.sh marks "not required but useful".
 *
 * Thousands of roadmaps are generated (every node with ≥ 4 children), so the
 * artifact is one file the index page fetches once and the viewer pages fetch
 * on demand by slug.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/artifacts');

const MIN_CHILDREN = 4;
const MAX_ROW = 5;

const slugify = (s) => s.toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'field';

function buildRoadmap(node, children, nodes, xlinksByNode) {
  // Foundation-first: the subfield that reaches the most of the field is the
  // one to meet first. Ties fall back to name so output is deterministic.
  const ordered = [...children].sort((a, b) =>
    (nodes[b].size ?? 0) - (nodes[a].size ?? 0) || nodes[a].name.localeCompare(nodes[+b].name));

  const rows = [];
  for (let i = 0; i < ordered.length; i += MAX_ROW) {
    rows.push(ordered.slice(i, i + MAX_ROW));
  }

  const COL_W = 250;
  const ROW_H = 150;
  const ZIG = 60; // half-column offset that gives the roadmap.sh zigzag

  const nodesOut = [];
  const idxOf = new Map();
  rows.forEach((row, r) => {
    row.forEach((ci, c) => {
      const n = nodes[ci];
      const x = c * COL_W + (r % 2 ? ZIG : 0);
      const y = r * ROW_H;
      idxOf.set(ci, nodesOut.length);
      nodesOut.push({
        id: n.id, label: n.name, level: r,
        x, y,
        kind: 'primary',
        desc: n.description ?? null,
        wiki: n.wiki ?? null,
        size: n.size ?? 1,
      });
    });
  });

  // Spine: across each row, then down to the next row's first node — reading
  // order made physical.
  const edges = [];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length - 1; c++) {
      edges.push([idxOf.get(row[c]), idxOf.get(row[c + 1])]);
    }
    if (r < rows.length - 1 && row.length) {
      edges.push([idxOf.get(row[row.length - 1]), idxOf.get(rows[r + 1][0])]);
    }
  });

  // Optional side-nodes: fields related by a second parent edge, dotted.
  const related = (xlinksByNode.get(node.index ?? -1) ?? []).slice(0, 3);
  for (const ri of related) {
    if (idxOf.has(ri)) continue;
    const n = nodes[ri];
    const r = rows.length - 1;
    const x = (nodesOut.length % MAX_ROW) * COL_W + ZIG + 120;
    const y = r * ROW_H + ROW_H / 2;
    idxOf.set(ri, nodesOut.length);
    nodesOut.push({
      id: n.id, label: n.name, level: r, x, y,
      kind: 'optional', desc: n.description ?? null, wiki: n.wiki ?? null, size: n.size ?? 1,
    });
    // dotted link back to the roadmap's strongest node
    edges.push([idxOf.get(ordered[0]), nodesOut.length - 1]);
  }

  return { nodes: nodesOut, edges, levelCount: rows.length };
}

function main() {
  const structure = JSON.parse(readFileSync(resolve(OUT, 'structure.json'), 'utf8'));
  const { nodes, trunks } = structure;

  const childrenOf = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parent;
    if (p >= 0) {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(i);
    }
  }
  const xlinksByNode = new Map();
  for (const [a, b] of structure.xlinks) {
    if (!xlinksByNode.has(a)) xlinksByNode.set(a, []);
    if (!xlinksByNode.has(b)) xlinksByNode.set(b, []);
    xlinksByNode.get(a).push(b);
    xlinksByNode.get(b).push(a);
  }

  const usedSlug = new Set();
  const roadmaps = [];
  const index = [];

  /**
   * What a roadmap's steps are, per node kind:
   *   trunk     → its domains (the grand tour of a trunk)
   *   domain    → its curated subdomains when it has them, else its fields
   *   subdomain → its fields, when there are enough to path through
   *   field     → its sub-fields, when the pool kept real structure
   */
  const stepsFor = (i) => {
    const kids = childrenOf.get(i) ?? [];
    if (nodes[i].kind === 'domain') {
      const subs = kids.filter(k => nodes[k].kind === 'subdomain');
      if (subs.length >= 2) return subs;
    }
    return kids;
  };

  // Geographic wine-region branches ("Viticulture in Tuscany" and 150
  // cousins) each spawn a trivial two-step roadmap. They are places, not
  // disciplines, so they are skipped here; they remain in the atlas itself.
  const GEO_WINE = /^(viticulture|wine|grape cultivation|vineyard|winemaking|vintage) (in|of) /i;
  const WINE_FIELD = /\b(wine|viticulture|winemaking|viticulture|enology|vineyard)\b/i;
  for (let i = 0; i < nodes.length; i++) {
    const kind = nodes[i].kind;
    // Catch-all buckets ("Other Humanities Fields") hold real fields but a
    // path through "the 24 biggest leftovers" is not a curriculum.
    if (nodes[i].id.startsWith('other:')) continue;
    if (nodes[i].id === 'other:general') continue;
    if (kind === 'field' && (GEO_WINE.test(nodes[i].name) || WINE_FIELD.test(nodes[i].name))) continue;
    if (kind === 'field' && !childrenOf.get(i)?.some(k => nodes[k].kind === 'field')) continue;
    const kids = stepsFor(i);
    const min = kind === 'domain' ? 2 : MIN_CHILDREN;
    if (!kids || kids.length < min) continue;
    if (kind !== 'trunk' && kind !== 'domain' && kind !== 'subdomain' && kind !== 'field') continue;
    // A catch-all bucket can hold hundreds of fields; a path through the two
    // dozen largest is a roadmap, the full list is a dumping ground.
    const capped = [...kids]
      .sort((a, b) => (nodes[b].size ?? 0) - (nodes[a].size ?? 0))
      .slice(0, 24);
    const { nodes: rNodes, edges, levelCount } = buildRoadmap(nodes[i], capped, nodes, xlinksByNode);
    let slug = slugify(nodes[i].name);
    if (usedSlug.has(slug)) slug = `${slug}-${nodes[i].id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
    usedSlug.add(slug);
    roadmaps.push({ slug, node: i, nodes: rNodes, edges, levelCount });
    index.push({
      slug,
      title: nodes[i].name,
      node: i,
      kind: nodes[i].kind,
      trunk: nodes[i].trunk,
      trunkName: trunks[nodes[i].trunk]?.name ?? '',
      steps: rNodes.filter(n => n.kind === 'primary').length,
      depth: levelCount,
      desc: nodes[i].description ?? null,
      // popularity from scripts/popularity.mjs — the grand tour leads its
      // group, then the famous fields, the obscure at the end
      pop: nodes[i].kind === 'trunk' ? 10_000 : (nodes[i].pop ?? 0),
    });
  }

  index.sort((a, b) => a.trunk - b.trunk || b.pop - a.pop || b.steps - a.steps
    || a.title.localeCompare(b.title));

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'roadmaps.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    roadmaps,
    index,
  }));

  // node index -> roadmap slug: lets the domains tree link straight into a
  // field's roadmap from its notes drawer. Tiny, committed with the rest.
  const links = {};
  for (const e of index) links[e.node] = e.slug;
  writeFileSync(resolve(OUT, 'roadmap-links.json'), JSON.stringify(links));

  // The route table for /roadmap/[slug] — tiny, imported at build time so
  // getStaticPaths can enumerate the pages without pulling the full artifact
  // into the build graph.
  const dataDir = resolve(ROOT, 'src/data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'roadmap-slugs.json'), JSON.stringify(
    index.map(e => ({ slug: e.slug, title: e.title }))));
  console.log(`roadmaps: ${roadmaps.length} (index entries: ${index.length})`);
  const byTrunk = {};
  for (const e of index) byTrunk[e.trunkName] = (byTrunk[e.trunkName] ?? 0) + 1;
  console.log(byTrunk);
}

main();
