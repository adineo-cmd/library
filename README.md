# Arbor

A field atlas for wandering minds — a static, visual map of human knowledge:
domains, sub-domains, learning roadmaps and a global constellation graph built
with Astro + Svelte + D3.

## Views

| Route       | What it shows                                                        |
| ----------- | -------------------------------------------------------------------- |
| `/`         | The main trunks of the atlas (D3 radial branch view, searchable)     |
| `/domains`  | Full interactive domain tree — expand/collapse, zoom, deep links      |
| `/roadmap`  | Learning roadmaps rendered from JSON in `src/data/roadmaps/`          |
| `/graph`    | Constellation of every mapped field, clustered by trunk               |

All three views read from the same source of truth: `src/data/Domain/domains.json`.

## Development

Requires Node.js >= 22.12.

```sh
npm install
npm run dev      # local dev server at localhost:4321
npm run build    # static site into ./dist
```

## Adding data

- **Domains** — edit `src/data/Domain/domains.json` (hierarchical `name` / `id` / `children`).
- **Roadmaps** — drop a new `.json` file into `src/data/roadmaps/`; it appears on `/roadmap` automatically.
- **Graph adjacency** — cross-trunk threads are curated in `src/pages/graph.astro`.

## Where to gather data

Curated, open taxonomies you can seed the atlas from:

- [Dewey Decimal Classification](https://en.wikipedia.org/wiki/Dewey_Decimal_Classification) and the [Library of Congress Classification](https://loc.gov/classification/) — classic, complete field hierarchies.
- [Wikidata](https://www.wikidata.org) (`P279` subclass-of queries against "academic discipline") and Wikipedia's [Outline of academic disciplines](https://en.wikipedia.org/wiki/Outline_of_academic_disciplines).
- [DBpedia](https://www.dbpedia.org) / [YAGO](https://yago-knowledge.org) — free knowledge graphs with discipline relations.
- [OpenAlex](https://openalex.org) and [Microsoft Academic Graph](https://mag.cambridge.org/) — topic classifications per research field.
- [roadmap.sh](https://roadmap.sh) JSON, [FreeCodeCamp](https://www.freecodecamp.org/news/), and university curricula for learning paths.
- [arXiv categories](https://arxiv.org/category_taxonomy) and [ACM CCS](https://dl.acm.org/ccs) for CS/math structure.

Keep everything under an open licence (CC0/CC-BY) and record provenance per node.
