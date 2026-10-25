# Memex

> A knowledge platform for discovering fields and new topics.

Memex maps the space of human knowledge into a browsable tree and an
interactive graph view — fields ranked by reach, connections drawn between
adjacent domains, and artifacts wired to real sources.

## Features

- **Browse tree** — every field organized hierarchically
- **Graph view** — interactive map of cross-field connections
- **Reach ranking** — fields weighted by how many other fields they unlock
- **Trunk preservation** — the structural backbone of knowledge kept intact

## Architecture

Astro + Svelte, static-first. Pages in `src/pages/`, UI components in
Svelte, content artifacts in `public/`.

## Quick start

```bash
npm install
npm run dev
```

## Live site

**https://adineo-cmd.github.io/memex/**

Deployed to GitHub Pages on every push to `main`
(`.github/workflows/deploy.yml`). Work in progress lands on side branches
and merges after review.
