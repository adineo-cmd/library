# Memex

> A knowledge platform for discovering fields and new topics.

Memex maps the space of human knowledge into a browsable atlas: **9,261
discipliplines** arranged under **8 curated trunks** (Sciences, Mathematics &
Logic, Technology & Computing, Humanities, Social Sciences, Arts & Culture,
Health & Medicine, Law & Governance), each field with its own
**roadmap.sh-style learning path**.

## Views

| Route | What it is |
|---|---|
| `/` | The atlas root fanning out to the eight trunks. |
| `/domains` | Root → trunks → domains fan, then one section per domain with its curated subdomains and the fields beneath. |
| `/roadmap` | An index of every learning path; `/roadmap/[slug]` draws one as a stepped path with tickable progress. |
| `/graph` | The whole atlas as a drifting constellation — clusters glow by trunk, drag to pan, scroll to zoom, click a star to isolate its neighbourhood. |

## Where the data comes from

The structural spine is a **hand-curated taxonomy** (`scripts/spine.mjs`):
eight trunks, ~65 domains, ~430 subdomains, written out with keyword
matchers. Underneath it sits the **Wikidata academic-discipline subtree**
(P279 descendants of [Q11862829](https://www.wikidata.org/wiki/Q11862829)):
~9,700 real fields with English labels, descriptions and Wikipedia links.

An earlier build derived the whole tree from the English Wikipedia category
dumps. That pipeline is kept under `scripts/` but no longer drives the site:
the category graph produced 23,145 orphan roots out of 30,041 nodes —
Wikipedia's category system is a tangle, not a hierarchy, and no amount of
pattern-filtering made the top of the tree presentable. Wikidata's curated
subclass-of tree is clean all the way up.

## Pipeline

```
scripts/fetch-taxonomy.mjs    # Wikidata -> atlas-work/wikidata-{edges,labels}.json  (cached, merge-mode)
scripts/spine.mjs             # the hand-curated 8-trunk structure
scripts/build-structure.mjs   # classify the pool under the spine, force layout -> public/data/artifacts/
scripts/build-roadmaps.mjs    # a learning path per domain/subdomain/field -> public/data/artifacts/roadmaps.json
npm run build:artifacts       # the legacy Wikipedia pipeline (kept, not required)
npm run dev / build           # Astro serves the artifacts from public/data/artifacts
```

`fetch-taxonomy.mjs` refetches only what is missing, so a dropped batch costs
one rerun, not the whole taxonomy. Caches live in `atlas-work/` (gitignored).

## Roadmap generation

`build-roadmaps.mjs` turns every qualifying node into a learning path: a
trunk's path runs through its domains; a domain's through its curated
subdomains; a subdomain's or field's through its children. Children are
ordered foundation-first (largest subtree first), laid out in rows with the
roadmap.sh zigzag, and the node's crosslink neighbours join as dotted
optional steps. Progress ticks are stored in `localStorage` per slug; there
are no accounts.

## Development

```
npm install
node scripts/fetch-taxonomy.mjs      # first run: ~4 min, then cached
node scripts/build-structure.mjs     # ~40 s (force layout)
node scripts/build-roadmaps.mjs      # ~10 s
npm run dev
```

Tests: `npm test` (333 pipeline assertions).
