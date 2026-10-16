import { slugify } from './slug.mjs';

/**
 * The artifact layer. Every function here is a pure projection of already-
 * pruned data into the JSON shapes the frontend validates with zod
 * (`src/lib/artifacts/schemas.ts`); nothing here recomputes graph structure.
 *
 * `buildConceptsFile` maps its input in order, so the emitted `nodes` array
 * has dense 0..n-1 indices by construction and `parent` is an array index,
 * not a string. The caller must pass nodes already compacted into final
 * emit order with parents remapped to those indices — the rank cut leaves
 * `kept` as a sparse bitmask over the post-cap index space, and compaction
 * (old index -> new index) is the caller's step. The zod schema is the
 * enforcement point: it rejects an out-of-range parent, a self-parent,
 * duplicate ids and a nodeCount that disagrees with the array length, so a
 * mis-compacted file fails the build loudly rather than corrupting silently.
 */
export function buildConceptsFile(nodes, dumpDate, version) {
  // `slugify` lowercases, so two categories whose names differ only in case
  // collapse to the same id. Wikipedia really does contain both `Asian Games`
  // and `Asian games`, and both `Production (economics)` and `Production
  // economics`; the real dump produced two duplicate ids that the zod schema
  // rejected, which failed the frontend at load time rather than at build time.
  //
  // Disambiguate here, at the emitter, because it is the only place that sees
  // every node at once. The first claimant keeps the bare slug, so the common
  // case stays clean and readable and only genuine collisions grow a suffix.
  // Emission order is stable (the rank cut's order), so which node wins a bare
  // slug is deterministic across runs rather than depending on iteration order.
  const taken = new Map();
  const uniqueId = (name, explicitId) => {
    const base = explicitId ?? slugify(name);
    const seen = taken.get(base);
    if (seen === undefined) {
      taken.set(base, 1);
      return base;
    }
    taken.set(base, seen + 1);
    return `${base}-${seen}`;
  };

  return {
    version,
    dumpDate,
    nodeCount: nodes.length,
    nodes: nodes.map(n => ({
      id: uniqueId(n.name, n.id),
      name: n.name,
      parent: n.parent,
      depth: n.depth,
      articleCount: n.articleCount,
      aliases: n.aliases ?? [],
    })),
  };
}

export function buildCrosslinksFile(edges) {
  return { edges };
}

export const DEFAULT_SOURCES = [
  {
    name: 'English Wikipedia page table (namespace 14)',
    url: 'https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-page.sql.gz',
    license: 'CC BY-SA 4.0 / GFDL',
  },
  {
    name: 'English Wikipedia category table',
    url: 'https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-category.sql.gz',
    license: 'CC BY-SA 4.0 / GFDL',
  },
  {
    name: 'English Wikipedia categorylinks table',
    url: 'https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-categorylinks.sql.gz',
    license: 'CC BY-SA 4.0 / GFDL',
  },
  {
    name: 'English Wikipedia linktarget table',
    url: 'https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-linktarget.sql.gz',
    license: 'CC BY-SA 4.0 / GFDL',
  },
];

/**
 * `counts` carries the funnel the /method page reports: rawCategories ->
 * afterMetaFilter -> afterDepthCap -> finalNodes, plus restoredAncestors
 * (the pass-5 exemption count — how many nodes came back solely to keep
 * kept nodes reachable), crosslinks and danglingCrosslinks. `params` is the
 * exact method configuration the run used, so the artifacts are auditable
 * against the settings that produced them.
 */
export function buildMeta(counts, params, dumpDate, version, generatedAt) {
  return { version, generatedAt, dumpDate, counts, params, sources: DEFAULT_SOURCES };
}
