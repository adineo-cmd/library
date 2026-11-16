<div align="center">

# Library

**A browsable atlas of human knowledge — 28,649 disciplines under twelve trunks.**

[![Live site](https://img.shields.io/badge/live-site-2ea44f?logo=githubpages&logoColor=white)](https://adineo-cmd.github.io/library/)
![Astro](https://img.shields.io/badge/Astro-BC52EE?logo=astro&logoColor=white) ![Svelte](https://img.shields.io/badge/Svelte-FF3E00?logo=svelte&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![D3](https://img.shields.io/badge/D3.js-F9A03C?logo=d3&logoColor=white) ![Tailwind](https://img.shields.io/badge/Tailwind-06B6D4?logo=tailwindcss&logoColor=white) ![GitHub Actions](https://img.shields.io/badge/Actions-2088FF?logo=githubactions&logoColor=white)

[![Stars](https://img.shields.io/github/stars/adineo-cmd/library?style=flat&logo=github&label=stars)](https://github.com/adineo-cmd/library/stargazers) [![Last commit](https://img.shields.io/github/last-commit/adineo-cmd/library?style=flat)](https://github.com/adineo-cmd/library/commits)

[Live site](https://adineo-cmd.github.io/library/) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Features](#features)

</div>

---

Library maps the space of human knowledge into something you can actually
navigate: twelve curated trunks, each fanning out into domains, subdomains and
fields. Every one of the **28,649 disciplines** has a place, and the atlas ships
**694 roadmap-style learning paths**.

The structural spine is hand-curated; the long tail comes from Wikidata's
academic-discipline subtree, so labels and links are real.

## Features

| | Feature | What it does |
| --- | --- | --- |
| 🌳 | **Twelve-trunk atlas** | Root → trunk → domain → subdomain → field, all navigable. |
| 🧭 | **694 learning paths** | A stepped path per field, with progress you tick off as you go. |
| ✨ | **Constellation graph** | The whole atlas as a force graph: zoom, pan, isolate a neighbourhood. |
| 🔍 | **Curated structure** | A hand-written spine keeps the top of the tree presentable. |

## How it works

The atlas is built before Astro ever runs:

1. `scripts/fetch-taxonomy.mjs` pulls the Wikidata discipline subtree.
2. `scripts/spine.mjs` applies the hand-curated twelve-trunk structure.
3. `scripts/build-structure.mjs` classifies the pool and computes the layout.
4. `scripts/build-paths.mjs` generates a learning path per field.
5. Astro serves the resulting artifacts from `public/data/artifacts/`.

The legacy Wikipedia-category pipeline is kept for reference but no longer
drives the site — its category graph produced 23,145 orphan roots out of 30,041
nodes, which is why the curated spine exists.

```mermaid
flowchart LR
  A[Wikidata discipline subtree] --> B[fetch-taxonomy.mjs]
  C[Curated spine] --> D[spine.mjs]
  B --> D
  D --> E[build-structure.mjs]
  E --> F[structure.json + layout]
  E --> G[build-paths.mjs]
  G --> H[roadmaps.json]
  F --> I[Astro pages]
  H --> I
```

## Quick start

**Install and run**

```bash
npm install
npm run dev
```

**Production build**

```bash
npm run build
npm run preview
```

## Project structure

```text
scripts/
  fetch-taxonomy.mjs   Wikidata → cached edges/labels
  spine.mjs            curated trunks, domains, subdomains
  build-structure.mjs  classify + force layout
  build-paths.mjs      learning paths
src/pages/             atlas, domains, paths, graph
public/data/artifacts/ generated structure and roadmaps
src/components/        Svelte views and graph widgets
```

## Deployment

Every push to `main` builds the site and deploys it to GitHub Pages
through `.github/workflows/deploy.yml`:

**https://adineo-cmd.github.io/library/**

## Rebuilding the artifacts

```bash
npm run ingest           # refresh the Wikidata taxonomy
node scripts/build-structure.mjs
node scripts/build-paths.mjs
npm run dev
```

Tests: `npm test` (vitest) and `npm run test:e2e` (Playwright).
