# Knowledge Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static, GitHub-Pages-hosted atlas of ~30,000 Wikipedia categories, generated offline from the 4.6 GB `enwiki` SQL dumps and rendered as a browsable tree, a field page, and a WebGL constellation.

**Architecture:** A Node ingest pipeline streams the two `enwiki` dumps into a local SQLite database, prunes ~4M categories down to ~30k through five ordered passes, computes an article-co-occurrence cross-link layer, and precomputes a force-directed layout. All four outputs are committed to `src/data/artifacts/`. The Astro frontend reads only those artifacts; CI never touches the dumps.

**Tech Stack:** Node 22, `better-sqlite3`, `d3-force` (offline only), Astro 7, Svelte 5, Tailwind 4, `sigma@^3` + `graphology`, `zod`, `vitest`, `@playwright/test`.

**Spec:** `memex/docs/superpowers/specs/2026-10-11-knowledge-atlas-design.md`

---

## Global Constraints

These apply to every task. Values are copied verbatim from the spec.

- **Node target:** exactly 30,000 concepts, restored ancestors exempt from the cap.
- **Max depth:** 5. Deeper nodes are re-parented to their depth-5 ancestor.
- **Cross-link eligibility:** `articleCount >= 10`.
- **Cross-link threshold:** `>= 3` shared articles.
- **Cross-link degree:** top 20 per category, global cap 400,000 edges.
- **Member sample:** 200 articles per eligible category.
- **Layout:** `d3-force`, `.stop().tick(150)`, `theta: 0.9`, no `forceCollide`, `alphaDecay: 0.05`, seeded RNG.
- **Binary node index width:** `Uint16` — hard cap 65,535 concepts. Exceeding it must fail the build loudly.
- **GitHub Pages:** published site <= 1 GB; deploy timeout 10 minutes; repo <= 1 GB recommended.
- **Source dumps** (`enwiki-latest-*.sql.gz`, 4.6 GB) live in the workspace root and are **never** committed. Root `.gitignore` already excludes `*.sql.gz`.
- **Search is a zero-dependency linear scan.** No search library.
- **No live force simulation in the browser.** Layout is always precomputed.
- **No branding.** The site carries no name, wordmark, or tagline. Navigation is `Browse / Graph / Method`.
- **Malformed artifacts fail the build loudly.** The current `content-loader.ts` behaviour of logging-and-continuing is explicitly inverted and must not be reintroduced.
- **Field pages are pre-rendered for the top 5,000 concepts only** (ranked by `articleCount`). The remaining ~25,000 nodes remain reachable through the tree and graph views but have no dedicated detail page in v1. This bound exists because generating 30,000 static pages risks the 10-minute Pages deploy timeout.

---

## File Structure

Everything below is created or modified by the plan. Paths are relative to `memex/`.

**Offline pipeline** (`scripts/`) — runs on a developer machine, never in CI.

| File | Responsibility |
|---|---|
| `scripts/lib/slug.mjs` | `slugify` — shared by the pipeline and the frontend |
| `scripts/lib/sql-stream.mjs` | Streaming parser for MySQL `INSERT` statements in `.sql.gz` |
| `scripts/lib/categories.mjs` | Category-name normalization and the meta-filter regex list |
| `scripts/lib/db.mjs` | SQLite schema creation, stable id assignment, index creation |
| `scripts/lib/prune.mjs` | The five pruning passes, each an exported pure function |
| `scripts/lib/emit.mjs` | Artifact object construction |
| `scripts/ingest.mjs` | Streams both dumps into SQLite; builds `cat`, `parent`, `member` |
| `scripts/crosslink.mjs` | Pair counting and top-K truncation |
| `scripts/layout.mjs` | Precomputed force layout; writes `layout.bin` |
| `scripts/build-artifacts.mjs` | Orchestrates prune -> concepts.json -> crosslinks.json -> meta.json |

**Frontend library** (`src/lib/`) — the only code that knows file formats exist.

| File | Responsibility |
|---|---|
| `src/lib/artifacts/types.ts` | `Concept`, `CrossLink`, `ConceptsFile`, `Meta`, `MethodParams` |
| `src/lib/artifacts/schemas.ts` | Zod schemas validating each artifact |
| `src/lib/artifacts/load.ts` | `loadConcepts`, `loadCrosslinks`, `parseLayout`, `loadMeta` |
| `src/lib/artifacts/graph.ts` | `buildIndex`, `ancestorsOf`, `descendantsOf`, `subtreeSize`, `pathToRoot` |
| `src/lib/artifacts/index.ts` | Barrel re-export |

**Components** (`src/components/`).

| File | Responsibility |
|---|---|
| `src/components/tree/CollapsibleTree.svelte` | d3 tree layout, zoom, expand/collapse, transitions |
| `src/components/tree/TreeNode.svelte` | One node's label, article count, expand affordance |
| `src/components/search/search.ts` | Pure linear-scan search function |
| `src/components/search/SearchBox.svelte` | Input, debounce, result list |
| `src/components/field/FieldHeader.svelte` | Breadcrumb, name, counts |
| `src/components/field/ChildList.svelte` | Children sorted by article count |
| `src/components/field/CrossLinks.svelte` | "Also appears under" and "Related fields" |
| `src/components/graph/Atlas.svelte` | Thin mount/unmount wrapper |
| `src/components/graph/atlas-controller.ts` | sigma setup, camera, filters, picking |
| `src/components/layout/BaseLayout.astro` | Branding removed |
| `src/components/layout/TopBar.astro` | Minimal navigation |

**Pages** (`src/pages/`): `index.astro` (`/`), `domains/[slug].astro`, `graph.astro` (`/graph`), `method.astro` (`/method`).

**Deleted:** `src/utils/content-loader.ts`, `src/utils/graph-builder.ts`, `src/utils/types.ts`, all of `src/components/views/`, `src/pages/domains.astro`, `src/pages/roadmap.astro`, `src/pages/roadmap/[slug].astro`, `src/data/Domain/`, `src/data/roadmaps/`.

---

## Task 1: Repo hygiene, dependencies, and test harness

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `playwright.config.ts`
- Delete: the superseded sources listed above

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `test`, `test:e2e`, `build`, `build:artifacts`, `ingest`. Dependency set `{ d3, sigma@^3, graphology, zod }` runtime; `{ better-sqlite3, d3-force, vitest, @playwright/test, @types/d3 }` dev.

- [ ] **Step 1: Remove dead dependencies and add the required ones**

```bash
npm uninstall reactflow dagre marked
npm install sigma@^3 graphology
npm install -D better-sqlite3 d3-force vitest @playwright/test
```

`reactflow` is a React library in a Svelte project and is entirely unused. `dagre` and `marked` have zero imports. Verify before continuing:

```bash
grep -rn "reactflow\|dagre\|from 'marked'" src/ || echo "confirmed unused"
```

Expected: `confirmed unused`.

- [ ] **Step 2: Delete the superseded source files**

These implement a model this project explicitly does not use (spec section 4.3). Leaving them in place keeps dead loaders alive.

```bash
rm -f src/utils/content-loader.ts src/utils/graph-builder.ts src/utils/types.ts
rm -rf src/components/views
rm -f src/pages/domains.astro
rm -rf src/pages/roadmap src/data/Domain src/data/roadmaps
```

`src/pages/graph.astro` is **not** deleted here — it still references the deleted `GlobalGraph`. Task 15 rewrites it. The build will fail until then, which is expected.

- [ ] **Step 3: Add npm scripts**

Replace the `scripts` block in `package.json`:

```json
{
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "ingest": "node scripts/ingest.mjs",
    "build:artifacts": "node scripts/build-artifacts.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "astro": "astro"
  }
}
```

`build` deliberately does **not** run `build:artifacts`. Artifacts are committed; regenerating them is a deliberate local action, not part of every build.

- [ ] **Step 4: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Configure Playwright**

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:4321', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4321',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 6: Configure TypeScript**

`tsconfig.json` extends the Astro starter's strict config but carries three settings this Svelte project does not use, and `baseUrl` is a hard error on TypeScript 6.0.3 (`TS5101: Option 'baseUrl' is deprecated`), which breaks `tsc --noEmit` and `astro check` project-wide.

- The `@/*`, `@components/*`, `@data/*`, `@utils/*` path aliases are referenced by nothing in this codebase or the plan.
- `jsx` / `jsxImportSource: "react"` are for JSX; this is a Svelte project with no JSX.

Replace the whole file with:

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "strictNullChecks": true
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.astro",
    "src/**/*.svelte",
    "scripts/**/*.mjs"
  ],
  "exclude": ["node_modules", "dist", ".astro"]
}
```

Verify:

```bash
npx tsc --noEmit
```

Expected: no `TS5101`. If path aliases are ever genuinely needed, reintroduce them using TypeScript 6's `paths` without `baseUrl` — do not add `ignoreDeprecations`, which suppresses the symptom on a setting nothing uses.

- [ ] **Step 7: Verify `better-sqlite3` loads natively**

```bash
node -e "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('create table t(a)');console.log('sqlite ok',d.prepare('select 1 as x').get().x)"
```

Expected: `sqlite ok 1`. If it fails, run `npm rebuild better-sqlite3` and stop if it still fails.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: strip dead loaders and views, add pipeline and test deps"
```

---

## Task 2: Artifact schema, types, and validation

**Files:**
- Create: `src/lib/artifacts/types.ts`, `schemas.ts`, `load.ts`, `index.ts`
- Test: `src/lib/artifacts/__tests__/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface Concept { id: string; name: string; parent: number; depth: number; articleCount: number; aliases: string[]; }
  export interface CrossLink { a: number; b: number; shared: number; }
  export interface ConceptsFile { version: string; dumpDate: string | null; nodeCount: number; nodes: Concept[]; }
  export interface CrosslinksFile { edges: CrossLink[]; }
  export interface LayoutArrays { x: Float32Array; y: Float32Array; treeSrc: Uint16Array; treeDst: Uint16Array; crossSrc: Uint16Array; crossDst: Uint16Array; crossWeight: Float32Array; }
  export interface MethodParams { nodeTarget: number; maxDepth: number; crosslinkMinArticleCount: number; crosslinkMinShared: number; crosslinkTopK: number; crosslinkGlobalCap: number; crosslinkMemberSample: number; metaFilterPatterns: string[]; }
  export interface Meta { version: string; generatedAt: string; dumpDate: string | null; counts: Record<string, number>; params: MethodParams; sources: { name: string; url: string; license: string }[]; }

  export function loadConcepts(raw: unknown): ConceptsFile;      // throws on invalid
  export function loadCrosslinks(raw: unknown): CrosslinksFile;  // throws on invalid
  export function loadMeta(raw: unknown): Meta;                  // throws on invalid
  // rootCount is REQUIRED: the tree is a forest, so tree edges = nodeCount - rootCount.
  // Derive it from concepts.json: nodes.filter(n => n.parent === -1).length
  export function parseLayout(
    buf: ArrayBuffer, nodeCount: number, rootCount: number, crosslinkCount: number,
  ): LayoutArrays;
  export function slugify(name: string): string;
  ```

- [ ] **Step 1: Write the failing validation test**

Create `src/lib/artifacts/__tests__/load.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConcepts, loadCrosslinks, parseLayout, slugify } from '../load';

const validNode = { id: 'physics', name: 'Physics', parent: -1, depth: 0, articleCount: 482913, aliases: [] };

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('History of Physics')).toBe('history-of-physics');
  });
  it('strips punctuation and collapses whitespace', () => {
    expect(slugify('  Physics: An  Introduction! ')).toBe('physics-an-introduction');
  });
  it('transliterates accents', () => {
    expect(slugify('Théorie des Jeux')).toBe('theorie-des-jeux');
  });
  it('drops characters with no URL-safe form', () => {
    expect(slugify('A / B (C)')).toBe('a-b-c');
  });
});

describe('loadConcepts', () => {
  const valid = { version: '1', dumpDate: '2026-08-05', nodeCount: 1, nodes: [validNode] };

  it('accepts a well-formed file', () => {
    expect(loadConcepts(valid).nodes[0].name).toBe('Physics');
  });
  it('throws when nodes is empty', () => {
    expect(() => loadConcepts({ ...valid, nodeCount: 0, nodes: [] })).toThrow(/nodeCount/i);
  });
  it('throws when a parent index is out of range', () => {
    expect(() => loadConcepts({ ...valid, nodes: [{ ...validNode, parent: 99 }] })).toThrow(/parent/i);
  });
  it('throws when depth exceeds 5', () => {
    expect(() => loadConcepts({ ...valid, nodes: [{ ...validNode, depth: 6 }] })).toThrow(/depth/i);
  });
  it('throws on duplicate ids', () => {
    expect(() => loadConcepts({ ...valid, nodeCount: 2, nodes: [validNode, { ...validNode, parent: 0 }] }))
      .toThrow(/duplicate/i);
  });
  it('throws when a node is its own parent', () => {
    expect(() => loadConcepts({ ...valid, nodes: [{ ...validNode, parent: 0 }] })).toThrow(/parent/i);
  });
});

describe('loadCrosslinks', () => {
  it('accepts a well-formed file', () => {
    expect(loadCrosslinks({ edges: [{ a: 0, b: 1, shared: 4 }] }).edges).toHaveLength(1);
  });
  it('throws when a >= b, breaking undirected deduplication', () => {
    expect(() => loadCrosslinks({ edges: [{ a: 5, b: 2, shared: 4 }] })).toThrow(/a < b|unordered/i);
  });
  it('throws on a duplicate pair', () => {
    expect(() => loadCrosslinks({ edges: [{ a: 0, b: 1, shared: 4 }, { a: 0, b: 1, shared: 3 }] }))
      .toThrow(/duplicate/i);
  });
});

describe('parseLayout', () => {
  const build = (nodeCount: number, rootCount: number, crosslinkCount: number) =>
    new ArrayBuffer(nodeCount * 8 + (nodeCount - rootCount) * 4 + crosslinkCount * 8);

  it('returns arrays matching the node and crosslink counts', () => {
    const l = parseLayout(build(3, 1, 1), 3, 1, 1);
    expect(l.x).toBeInstanceOf(Float32Array);
    expect(l.x).toHaveLength(3);
    expect(l.treeSrc).toHaveLength(2);
    expect(l.crossSrc).toHaveLength(1);
    expect(l.crossWeight).toHaveLength(1);
  });
  it('handles a forest: 4 nodes with 2 roots has 2 tree edges, not 3', () => {
    const l = parseLayout(build(4, 2, 0), 4, 2, 0);
    expect(l.treeSrc).toHaveLength(2);
  });
  it('throws when the buffer is shorter than the declared layout', () => {
    expect(() => parseLayout(new ArrayBuffer(8), 3, 1, 0)).toThrow(/truncated|layout/i);
  });
  it('throws when the node count exceeds the Uint16 index limit', () => {
    expect(() => parseLayout(new ArrayBuffer(4), 70_000, 1, 0)).toThrow(/65535|Uint16/i);
  });
  it('throws when rootCount is zero or exceeds nodeCount', () => {
    const buf = build(3, 1, 0);
    expect(() => parseLayout(buf, 3, 0, 0)).toThrow(/rootCount/i);
    expect(() => parseLayout(buf, 3, 4, 0)).toThrow(/rootCount/i);
  });
  it('includes the tree-edge count in the truncation message', () => {
    expect(() => parseLayout(new ArrayBuffer(8), 4, 2, 0)).toThrow(/2 tree edges/);
  });
  it('accepts a forest of isolated roots (zero tree edges)', () => {
    const l = parseLayout(new ArrayBuffer(4 * 8), 4, 4, 0);
    expect(l.treeSrc).toHaveLength(0);
  });
  it('accepts a Buffer view without corrupting coordinates', () => {
    const padded = Buffer.concat([Buffer.alloc(8), Buffer.from(build(3, 1, 0))]);
    const l = parseLayout(padded, 3, 1, 0);
    expect(l.x).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/artifacts/__tests__/load.test.ts`
Expected: FAIL — `Cannot find module '../load'`.

- [ ] **Step 3: Write the types**

Create `src/lib/artifacts/types.ts` with the interface definitions listed in the Interfaces block above, copied verbatim.

- [ ] **Step 4: Write the Zod schemas**

Create `src/lib/artifacts/schemas.ts`:

```ts
import { z } from 'zod';

export const MAX_DEPTH = 5;
export const MAX_NODES = 65_535;

const conceptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parent: z.number().int(),
  depth: z.number().int().min(0).max(MAX_DEPTH),
  articleCount: z.number().int().min(0),
  aliases: z.array(z.string()),
});

export const conceptsFileSchema = z.object({
  version: z.string(),
  dumpDate: z.string().nullable(),
  nodeCount: z.number().int().positive(),
  nodes: z.array(conceptSchema).min(1),
}).superRefine((file, ctx) => {
  if (file.nodes.length !== file.nodeCount) {
    ctx.addIssue({ code: 'custom', message: `nodeCount ${file.nodeCount} != nodes.length ${file.nodes.length}` });
  }
  const seen = new Set<string>();
  file.nodes.forEach((n, i) => {
    if (seen.has(n.id)) ctx.addIssue({ code: 'custom', message: `duplicate id "${n.id}" at index ${i}` });
    seen.add(n.id);
    if (n.parent >= file.nodes.length) ctx.addIssue({ code: 'custom', message: `node ${i} parent ${n.parent} is out of range` });
    if (n.parent === i) ctx.addIssue({ code: 'custom', message: `node ${i} is its own parent` });
  });
});

const crossLinkSchema = z.object({
  a: z.number().int(), b: z.number().int(), shared: z.number().int().min(1),
}).refine(e => e.a < e.b, { message: 'crosslinks must be unordered: a < b' });

export const crosslinksFileSchema = z.object({
  edges: z.array(crossLinkSchema).superRefine((edges, ctx) => {
    const seen = new Set<string>();
    edges.forEach((e, i) => {
      const key = `${e.a}-${e.b}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate pair ${key} at index ${i}` });
      seen.add(key);
    });
  }),
});

export const methodParamsSchema = z.object({
  nodeTarget: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  crosslinkMinArticleCount: z.number().int().min(0),
  crosslinkMinShared: z.number().int().min(1),
  crosslinkTopK: z.number().int().min(1),
  crosslinkGlobalCap: z.number().int().min(1),
  crosslinkMemberSample: z.number().int().min(1),
  metaFilterPatterns: z.array(z.string()),
});

export const metaSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  dumpDate: z.string().nullable(),
  counts: z.object({
    rawCategories: z.number().int().nonnegative(),
    afterMetaFilter: z.number().int().nonnegative(),
    afterDepthCap: z.number().int().nonnegative(),
    finalNodes: z.number().int().nonnegative(),
    restoredAncestors: z.number().int().nonnegative(),
    crosslinks: z.number().int().nonnegative(),
    danglingCrosslinks: z.number().int().nonnegative(),
  }),
  params: methodParamsSchema,
  sources: z.array(z.object({ name: z.string(), url: z.string(), license: z.string() })),
});
```

- [ ] **Step 5: Write the loaders**

Create `src/lib/artifacts/load.ts`:

```ts
import { conceptsFileSchema, crosslinksFileSchema, metaSchema, MAX_NODES } from './schemas';
import type {
  ConceptsFile, CrosslinksFile, LayoutArrays, Concept, CrossLink, Meta,
} from './types';

export { slugify } from '../../../scripts/lib/slug.mjs';

export function loadConcepts(raw: unknown): ConceptsFile {
  return conceptsFileSchema.parse(raw);
}

export function loadCrosslinks(raw: unknown): CrosslinksFile {
  return crosslinksFileSchema.parse(raw);
}

export function loadMeta(raw: unknown): Meta {
  return metaSchema.parse(raw);
}

/**
 * Decompose the packed layout buffer. Section order and widths are fixed by
 * spec section 4.5; any size mismatch is corruption and must throw.
 */
export function parseLayout(
  buf: ArrayBuffer,
  nodeCount: number,
  rootCount: number,
  crosslinkCount: number,
): LayoutArrays {
  if (nodeCount > MAX_NODES) {
    throw new Error(`layout: nodeCount ${nodeCount} exceeds the Uint16 index limit of ${MAX_NODES}`);
  }
  if (rootCount < 1 || rootCount > nodeCount) {
    throw new Error(`layout: rootCount ${rootCount} is not between 1 and ${nodeCount}`);
  }
  // The tree is a FOREST. A node with parent === -1 is a root, so the edge
  // count is nodeCount - rootCount, never nodeCount - 1.
  const treeEdges = nodeCount - rootCount;
  const required = nodeCount * 8 + treeEdges * 4 + crosslinkCount * 8;
  if (buf.byteLength !== required) {
    throw new Error(
      `layout truncated: expected ${required} bytes for ${nodeCount} nodes / ` +
      `${treeEdges} tree edges / ${crosslinkCount} crosslinks, got ${buf.byteLength}`,
    );
  }
  // A view's bytes may sit at a non-zero byteOffset inside a larger (and for a
  // pooled Buffer, possibly unaligned) ArrayBuffer; copy it to offset 0.
  const bytes = ArrayBuffer.isView(buf)
    ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    : buf;
  const treeEdges = nodeCount - rootCount;
  const required = nodeCount * 8 + treeEdges * 4 + crosslinkCount * 8;
  if (bytes.byteLength !== required) {
    throw new Error(
      `layout truncated: expected ${required} bytes for ${nodeCount} nodes ` +
      `(${treeEdges} tree edges at ${rootCount} roots) / ` +
      `${crosslinkCount} crosslinks, got ${bytes.byteLength}`,
    );
  }
  let offset = 0;
  const take = <T extends Float32Array | Uint16Array>(
    Type: new (b: ArrayBuffer, o: number, n: number) => T, n: number,
  ): T => {
    const view = new Type(bytes, offset, n);
    offset += n * view.BYTES_PER_ELEMENT;
    return view;
  };
  return {
    x: take(Float32Array, nodeCount),
    y: take(Float32Array, nodeCount),
    treeSrc: take(Uint16Array, treeEdges),
    treeDst: take(Uint16Array, treeEdges),
    crossSrc: take(Uint16Array, crosslinkCount),
    crossDst: take(Uint16Array, crosslinkCount),
    crossWeight: take(Float32Array, crosslinkCount),
  };
}

export type { Concept, CrossLink, LayoutArrays, Meta, ConceptsFile, CrosslinksFile };
```

- [ ] **Step 6: Write the barrel and the shared slug helper**

Create `scripts/lib/slug.mjs`:

```js
export function slugify(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

Create `src/lib/artifacts/index.ts`:

```ts
export * from './types';
export * from './load';
export { conceptsFileSchema, crosslinksFileSchema, metaSchema, MAX_DEPTH, MAX_NODES } from './schemas';
```

- [ ] **Step 7: Run the test and verify it passes**

Run: `npx vitest run src/lib/artifacts/__tests__/load.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/artifacts scripts/lib/slug.mjs
git commit -m "feat(lib): artifact schema, zod validation and binary layout decoder"
```

---

## Task 3: Ingest — stream the dumps into SQLite

> **Schema correction (controller-ruled, empirically verified).** The real
> `categorylinks` schema is
> `(cl_from, cl_sortkey, cl_timestamp, cl_sortkey_prefix, cl_type, cl_collation_id, cl_target_id)`.
> There is **no title column**, and — critically — **`cl_target_id` is a `linktarget.lt_id`,
> not a `category.cat_id` and not a `page_id`.**
>
> Measured: resolving `cl_target_id` against `category.cat_id` yields **0.64%**; against ns-14
> `page_id` yields **~0%**; a full 222,744,137-row scan found **zero** matches for the cat_ids of
> Physics, Film, Biology, Chemistry, History, Mathematics and Music. The id space is independent
> of both, which is exactly what `linktarget` predicts.
>
> This task therefore requires a **fourth** dump, `enwiki-latest-linktarget.sql.gz` (1.44 GB):
>
> ```sql
> CREATE TABLE `linktarget` (
>   lt_id bigint unsigned AUTO_INCREMENT,
>   lt_namespace int NOT NULL,     -- 14 = category
>   lt_title varbinary(255) NOT NULL,   -- underscores, like page_title? NO: like cat_title
>   PRIMARY KEY (lt_id)
> )
> ```
>
> **The join:** `cl_target_id -> linktarget.lt_id -> lt_title` (filtered `lt_namespace = 14`).
>
> - category→category edge: when `cl_from` is an ns-14 page named X, edge is `X -> lt_title`
> - **significance signal is `category.cat_pages`**, authoritative and pre-computed by MediaWiki
>
> `member` rows are still required for Task 7 co-occurrence, keyed by `cl_from`.
>
> **Dump date consistency is a separate requirement:** the four dumps must come from one dated
> directory. `lt_id` values are stable across snapshots, but a mixed set still silently degrades.
>
> **Consequence — this task must fail loudly.** `ingest()` throws if the
> `cl_target_id -> lt_title` resolution rate is below 0.9, asserts non-trivial `keptMembers`,
> and validates input schemas **before** deleting any existing database. A silent 99% row loss
> after a multi-hour run is the failure mode this exists to prevent.

**Files:**
- Create: `scripts/lib/sql-stream.mjs`, `scripts/lib/categories.mjs`, `scripts/lib/db.mjs`, `scripts/ingest.mjs`
- Test: `scripts/lib/__tests__/sql-stream.test.mjs`, `categories.test.mjs`, `db.test.mjs`
- Fixture: `scripts/fixtures/mini-dump.sql`

**Interfaces:**
- Consumes: nothing from earlier tasks. This layer is independent of `src/lib`.
- Produces:
  ```js
  export async function streamInsertRows(filePath, onRow)  // onRow(tableName, values[]) -> void
  export function splitTuple(tuple)      // -> string[]
  export function* splitTuples(body)     // yields raw tuple bodies
  export function isMaintenanceCategory(name)  // -> boolean
  export const MAINTENANCE_PATTERNS           // -> string[] (regex sources)
  export function normalizeCategoryName(raw)   // -> string
  export function openDb(path)                 // -> Database with schema created
  export function assignStableIds(db)          // renumbers cat.id alphabetically, remaps FKs
  export function finalizeIndexes(db)
  export const PATHS                           // { page, category, categorylinks, db }
  export const INGEST_STATS                    // populated after a run
  export async function ingest()
  ```

- [ ] **Step 1: Create the fixture dump**

Create `scripts/fixtures/mini-dump.sql`. Every pipeline test depends on this file; keep it small and hand-checkable.

```sql
-- Minimal enwiki-shaped dump fragment for pipeline tests.
-- Table order mirrors the real dump: page before categorylinks.

INSERT INTO `page` VALUES
(1,0,'Physics','',0,0),
(2,0,'Entropy','',0,0),
(3,14,'Physical sciences','',0,0),
(4,14,'Thermodynamics','',0,0),
(5,14,'Information theory','',0,0),
(6,0,'CS1 references','',0,0),
(7,14,'CS1 references categories','',0,0);

INSERT INTO `categorylinks` VALUES
(3,'Physics','Physical sciences',0,''),
(4,'Thermodynamics','Physical sciences',0,''),
(5,'Information theory','Physical sciences',0,''),
(2,'Entropy','Thermodynamics',0,''),
(2,'Entropy','Information theory',0,''),
(1,'Physics','Physical sciences',0,''),
(6,'CS1 references','CS1 references categories',0,'');
```

- [ ] **Step 2: Write the failing SQL stream test**

Create `scripts/lib/__tests__/sql-stream.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamInsertRows } from '../sql-stream.mjs';

function gz(sql) {
  const path = join(mkdtempSync(join(tmpdir(), 'atlas-sql-')), 'f.sql.gz');
  writeFileSync(path, gzipSync(Buffer.from(sql, 'utf8')));
  return path;
}

const FIXTURE = gz(readFileSync(new URL('../../fixtures/mini-dump.sql', import.meta.url), 'utf8'));

describe('streamInsertRows', () => {
  it('parses every row across all tables', async () => {
    const seen = [];
    await streamInsertRows(FIXTURE, (t, v) => seen.push([t, v.length]));
    expect(seen.filter(s => s[0] === 'page')).toHaveLength(7);
    expect(seen.filter(s => s[0] === 'categorylinks')).toHaveLength(7);
  });

  it('handles multi-row INSERT statements without dropping rows', async () => {
    const rows = [];
    await streamInsertRows(FIXTURE, (t, v) => { if (t === 'page') rows.push(v[2]); });
    expect(rows).toEqual([
      'Physics', 'Entropy', 'Physical sciences', 'Thermodynamics',
      'Information theory', 'CS1 references', 'CS1 references categories',
    ]);
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
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/sql-stream.test.mjs`
Expected: FAIL — `Cannot find module '../sql-stream.mjs'`.

- [ ] **Step 4: Implement the streaming SQL parser**

Create `scripts/lib/sql-stream.mjs`. It holds at most one `INSERT` statement in memory; a single statement in the real dump runs to tens of megabytes.

```js
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

const INSERT_RE = /^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s+VALUES\s*/i;

/** Split one VALUES tuple into field strings. */
export function splitTuple(tuple) {
  const out = [];
  let cur = '';
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
    if (ch === "'") { inStr = true; i++; continue; }
    if (ch === ',') { out.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  out.push(cur);
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

export async function streamInsertRows(filePath, onRow) {
  const decoder = new StringDecoder('utf8');
  let table = null;
  let body = '';
  let pending = '';

  const drain = () => {
    for (;;) {
      if (table === null) {
        const idx = pending.search(/INSERT\s+INTO/i);
        if (idx === -1) {
          if (pending.length > 64) pending = pending.slice(-64);
          return;
        }
        const rest = pending.slice(idx);
        const m = rest.match(INSERT_RE);
        if (!m) { pending = rest; return; }
        table = m[1];
        body = rest.slice(m[0].length);
        pending = '';
      }
      const semi = body.indexOf(';');
      if (semi === -1) {
        if (body.length > 64 * 1024 * 1024) {
          throw new Error(`INSERT into ${table} exceeded 64MB without a terminator`);
        }
        return;
      }
      const stmt = body.slice(0, semi);
      body = body.slice(semi + 1);
      pending = body;
      body = '';
      const name = table;
      table = null;
      for (const tuple of splitTuples(stmt)) onRow(name, splitTuple(tuple));
    }
  };

  await new Promise((resolve, reject) => {
    const src = createReadStream(filePath).pipe(createGunzip());
    src.on('data', chunk => {
      try { pending += decoder.write(chunk); drain(); }
      catch (err) { src.destroy(err); reject(err); }
    });
    src.on('error', reject);
    src.on('end', () => {
      try { pending += decoder.end(); drain(); resolve(); }
      catch (err) { reject(err); }
    });
  });
}
```

**Contract:** `onRow` must be synchronous. The real `categorylinks.sql.gz` is 2.4 GB compressed; an async handler that awaits per row would be untenable. `ingest.mjs` batches inserts inside transactions instead.

- [ ] **Step 5: Write the failing category-filter test**

Create `scripts/lib/__tests__/categories.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { isMaintenanceCategory, normalizeCategoryName } from '../categories.mjs';

describe('normalizeCategoryName', () => {
  it('converts underscores to spaces and trims', () => {
    expect(normalizeCategoryName('Physical_sciences')).toBe('Physical sciences');
  });
  it('leaves a clean name alone', () => {
    expect(normalizeCategoryName('Thermodynamics')).toBe('Thermodynamics');
  });
  it('strips empty parentheses left by redirects', () => {
    expect(normalizeCategoryName('Foo ()')).toBe('Foo');
  });
});

describe('isMaintenanceCategory', () => {
  const kept = [
    'Physics', 'Thermodynamics', 'History of science',
    'Films of 1999', 'Association football', 'Mathematics',
    'Music theory', 'Mercury (planet)',
  ];
  const dropped = [
    'CS1 references', 'CS1 talk: inc', 'WikiProject Physics',
    'Wikipedia articles needing clarification', 'Template-related',
    'Use dmy dates', 'Articles with short description', 'Stubs',
    'Undated stubs needing attention', 'Interwiki', 'Commons category',
    '1900', '1990s', '20th century', 'All stub articles',
  ];

  it.each(kept)('keeps %s', name => expect(isMaintenanceCategory(name)).toBe(false));
  it.each(dropped)('drops %s', name => expect(isMaintenanceCategory(name)).toBe(true));
});
```

Note `Mercury (planet)` is in the kept list. The trailing-parenthesis rule is **not** included in the pattern list, because it would drop legitimate disambiguated names. `/method` reports the list verbatim so this stays auditable.

- [ ] **Step 6: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/categories.test.mjs`
Expected: FAIL — `Cannot find module '../categories.mjs'`.

- [ ] **Step 7: Implement the category helpers**

Create `scripts/lib/categories.mjs`:

```js
export const MAINTENANCE_PATTERNS = [
  '^CS\\d',
  '^WikiProject',
  '^Wikipedia ',
  '^Templates? ',
  '^Use dmy',
  '^Articles with ',
  '^Stub',
  '^Undated',
  '^Interwiki',
  '^Commons ',
  '^All ',
  'disambiguation',
  '^(1[89]|20)\\d\\d$',
  '^(1[89]|20)\\d\\d[_ -]s?$',
];

const COMPILED = MAINTENANCE_PATTERNS.map(p => new RegExp(p, 'i'));

export function normalizeCategoryName(raw) {
  return raw.replace(/_/g, ' ').replace(/\s*\(\s*\)\s*$/, '').trim();
}

export function isMaintenanceCategory(name) {
  return COMPILED.some(re => re.test(name));
}
```

**Documented heuristic cost:** `^All ` drops legitimate categories such as `All films`, and `^Stub` / `^Undated` drop some real ones. In practice maintenance categories dominate these prefixes, and `articleCount` ranking (pass 4) restores substantial survivors. The list is reported verbatim in `meta.json` and rendered on `/method`.

- [ ] **Step 8: Write the failing DB test**

Create `scripts/lib/__tests__/db.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { openDb, assignStableIds } from '../db.mjs';

describe('openDb', () => {
  it('creates the three ingest tables', () => {
    const db = openDb(':memory:');
    const names = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cat','parent','member')`,
    ).all().map(r => r.name).sort();
    expect(names).toEqual(['cat', 'member', 'parent']);
  });
});

describe('assignStableIds', () => {
  it('renumbers ids alphabetically so they do not depend on insert order', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Zebra');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Apple');
    assignStableIds(db);
    expect(db.prepare('SELECT id,name FROM cat ORDER BY id').all())
      .toEqual([{ id: 1, name: 'Apple' }, { id: 2, name: 'Zebra' }]);
  });

  it('remaps parent edges to the new ids', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Zebra');
    const child = db.prepare('SELECT id FROM cat WHERE name=?').get('Zebra').id;
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Apple');
    const parent = db.prepare('SELECT id FROM cat WHERE name=?').get('Apple').id;
    db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)').run(child, parent);
    assignStableIds(db);
    expect(db.prepare(
      'SELECT c.name AS child, p.name AS parent FROM parent e ' +
      'JOIN cat c ON c.id=e.child JOIN cat p ON p.id=e.parent',
    ).get()).toEqual({ child: 'Zebra', parent: 'Apple' });
  });

  it('remaps member rows to the new ids', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Zebra');
    const z = db.prepare('SELECT id FROM cat WHERE name=?').get('Zebra').id;
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Apple');
    const a = db.prepare('SELECT id FROM cat WHERE name=?').get('Apple').id;
    db.prepare('INSERT INTO member(article,cat) VALUES (?,?)').run('x', z);
    assignStableIds(db);
    expect(db.prepare(
      'SELECT m.article, c.name FROM member m JOIN cat c ON c.id=m.cat',
    ).get()).toEqual({ article: 'x', name: 'Zebra' });
    void a;
  });
});
```

- [ ] **Step 9: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/db.test.mjs`
Expected: FAIL — `Cannot find module '../db.mjs'`.

- [ ] **Step 10: Implement the DB layer**

Create `scripts/lib/db.mjs`:

```js
import Database from 'better-sqlite3';

export const SCHEMA = [
  'CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
  'CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)',
  'CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)',
];

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const stmt of SCHEMA) db.exec(stmt);
  return db;
}

/**
 * Renumber cat.id into alphabetical name order, remapping every foreign key.
 * Insert order in the real dumps depends on how MySQL streamed them;
 * alphabetical numbering makes ids reproducible across runs.
 */
export function assignStableIds(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('ALTER TABLE cat RENAME TO cat_raw');
  db.exec('CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  db.exec('INSERT INTO cat(id, name) SELECT ROW_NUMBER() OVER (ORDER BY name), name FROM cat_raw');

  db.exec('ALTER TABLE parent RENAME TO parent_raw');
  db.exec('CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)');
  db.exec(`INSERT INTO parent(child, parent)
            SELECT c2.id, c1.id FROM parent_raw r
            JOIN cat_raw c1 ON c1.id = r.child
            JOIN cat_raw c2 ON c2.id = r.parent`);

  db.exec('ALTER TABLE member RENAME TO member_raw');
  db.exec('CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)');
  db.exec(`INSERT INTO member(article, cat)
            SELECT r.article, c.id FROM member_raw r JOIN cat_raw c ON c.id = r.cat`);

  db.exec('DROP TABLE cat_raw');
  db.exec('DROP TABLE parent_raw');
  db.exec('DROP TABLE member_raw');
  db.exec('PRAGMA foreign_keys = ON');
}

export function finalizeIndexes(db) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_parent_child ON parent(child)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_parent_parent ON parent(parent)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_cat ON member(cat)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_article ON member(article)');
}
```

- [ ] **Step 11: Implement the ingest script**

Create `scripts/ingest.mjs`:

```js
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamInsertRows } from './lib/sql-stream.mjs';
import { normalizeCategoryName, isMaintenanceCategory } from './lib/categories.mjs';
import { openDb, assignStableIds, finalizeIndexes } from './lib/db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = resolve(ROOT, 'atlas-work');

// Dumps live at the PARENT of the repo by default; ATLAS_DUMP_DIR overrides.
// A hardcoded repo-relative path breaks on any other machine or layout.
const DUMP_DIR = process.env.ATLAS_DUMP_DIR
  ? resolve(process.env.ATLAS_DUMP_DIR)
  : (existsSync(resolve(ROOT, 'enwiki-latest-page.sql.gz')) ? ROOT : resolve(ROOT, '..'));

export const PATHS = {
  page: resolve(DUMP_DIR, 'enwiki-latest-page.sql.gz'),
  category: resolve(DUMP_DIR, 'enwiki-latest-category.sql.gz'),
  categorylinks: resolve(DUMP_DIR, 'enwiki-latest-categorylinks.sql.gz'),
  linktarget: resolve(DUMP_DIR, 'enwiki-latest-linktarget.sql.gz'),
  db: resolve(WORK, 'atlas.db'),
};

export const INGEST_STATS = {
  rawCategories: 0, afterMetaFilter: 0, keptParents: 0, keptMembers: 0,
  linkRows: 0, resolvedTargets: 0, targetResolution: 0,
};

/** Below this, the dump set is mismatched — refuse to continue. */
export const MIN_TARGET_RESOLUTION = 0.9;

export function missingInputs() {
  return [PATHS.page, PATHS.category, PATHS.categorylinks, PATHS.linktarget]
    .filter(p => !existsSync(p));
}

export async function ingest() {
  mkdirSync(WORK, { recursive: true });

  // Validate inputs BEFORE destroying any existing database. A failed run must
  // never destroy a prior multi-hour result.
  const missing = missingInputs();
  if (missing.length) throw new Error('Missing input dumps:\n  ' + missing.join('\n  '));
  const schemas = {};
  for (const [key, path] of Object.entries({
    page: PATHS.page, category: PATHS.category,
    categorylinks: PATHS.categorylinks, linktarget: PATHS.linktarget,
  })) {
    schemas[key] = await readDumpSchema(path);
    if (!schemas[key].size) throw new Error(`No CREATE TABLE found in ${path}; dump looks wrong`);
  }

  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(PATHS.db + suffix)) rmSync(PATHS.db + suffix);
  }
  const db = openDb(PATHS.db);

  const insCat = db.prepare('INSERT OR IGNORE INTO cat(name) VALUES (?)');
  const insParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
  const insMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');

  // --- Pass A: page table -> which pages are categories (namespace 14)? ---
  const catPageIds = new Set();
  let categoryRows = 0;
  const insertCats = db.transaction((rows) => { for (const n of rows) insCat.run(n); });
  let catBatch = [];
  await streamInsertRows(PATHS.page, (table, v) => {
    if (table !== 'page' || v[1] !== '14') return;
    const name = normalizeCategoryName(v[2]);
    if (!name || isMaintenanceCategory(name)) return;
    categoryRows++;
    catPageIds.add(v[0]);
    catBatch.push(name);
    if (catBatch.length >= 50_000) { insertCats(catBatch); catBatch = []; }
  });
  if (catBatch.length) insertCats(catBatch);
  INGEST_STATS.rawCategories = categoryRows;
  INGEST_STATS.afterMetaFilter = db.prepare('SELECT COUNT(*) AS n FROM cat').get().n;

  const idByName = new Map(
    db.prepare('SELECT id,name FROM cat').all().map(r => [r.name, r.id]),
  );

  // Rebuild page_id -> cat id for the surviving categories only.
  const idByPageId = new Map();
  await streamInsertRows(PATHS.page, (table, v) => {
    if (table !== 'page' || v[1] !== '14' || !catPageIds.has(v[0])) return;
    const id = idByName.get(normalizeCategoryName(v[2]));
    if (id !== undefined) idByPageId.set(v[0], id);
  });

  // --- Pass A2: linktarget -> lt_id -> category name --------------------
  // cl_target_id is a linktarget.lt_id. ONLY namespace 14 (category pages)
  // matter here; other namespaces are article/file/special targets.
  const ltIdToName = new Map();
  await streamInsertRows(PATHS.linktarget, (table, v) => {
    if (table !== 'linktarget') return;
    if (v[LT_NAMESPACE] !== '14') return;
    const name = normalizeCategoryName(v[LT_TITLE]);
    const id = idByName.get(name);
    if (id !== undefined) ltIdToName.set(Number(v[LT_ID]), id);
  });
  if (ltIdToName.size === 0) {
    throw new Error(
      'linktarget produced zero ns-14 targets. The linktarget dump must come from the ' +
      'SAME snapshot date as categorylinks, otherwise lt_id values will not join.',
    );
  }

  // --- Pass B: categorylinks -> category->category edges + membership ---
  // `member.article` holds the cl_from page_id. Article identity is only ever
  // used to count co-membership between categories, never displayed, so a
  // title join is unnecessary. The category NAME comes from the category dump
  // via cl_target_id -> cat_id, NOT from a column in categorylinks (there
  // is none).
  let linkRows = 0;
  let resolvedTargets = 0;

  const flushMembers = db.transaction((rows) => {
    for (const [article, catId] of rows) insMember.run(article, catId);
  });
  const flushParents = db.transaction((rows) => {
    for (const [childPageId, parentCatId] of rows) {
      const childId = idByPageId.get(childPageId);
      if (childId === undefined) continue;
      insParent.run(childId, parentCatId);
    }
  });

  const memberBatch = [];
  const parentBatch = [];
  await streamInsertRows(PATHS.categorylinks, (table, v) => {
    if (table !== 'categorylinks') return;
    linkRows++;
    const pageId = v[CL_FROM];
    const parentCatId = ltIdToName.get(Number(v[CL_TARGET_ID]));
    if (parentCatId === undefined) return;   // unresolvable target; counted by the guard
    resolvedTargets++;
    memberBatch.push([pageId, parentCatId]);
    if (idByPageId.has(pageId)) parentBatch.push([pageId, parentCatId]);
    if (memberBatch.length >= 50_000) { flushMembers(memberBatch.splice(0)); }
    if (parentBatch.length >= 50_000) { flushParents(parentBatch.splice(0)); }
  });
  if (memberBatch.length) flushMembers(memberBatch);
  if (parentBatch.length) flushParents(parentBatch);

  assignStableIds(db);
  INGEST_STATS.keptParents = db.prepare('SELECT COUNT(*) AS n FROM parent').get().n;
  INGEST_STATS.keptMembers = db.prepare('SELECT COUNT(*) AS n FROM member').get().n;

  finalizeIndexes(db);

  // --- Fail loudly on catastrophic row loss -------------------------------
  // A dump set from mismatched dates resolves cl_target_id against cat_id for
  // only ~0.6% of rows while every counter still looks plausible. That must
  // never pass silently: it costs hours and produces a graph that looks valid.
// The guard measures the JOIN ALONE. Categories dropped by the meta filter
  // are reported separately, not folded in: on the real dumps they are ~29% of
  // all rows, so counting them as join failures would abort every correct run
  // and teach the operator to ignore the guard. Measured on real data:
  // join = 100.00%, meta-filter survival = 70.64%.
  INGEST_STATS.linkRows = linkRows;
  INGEST_STATS.resolvedTargets = resolvedTargets;
  INGEST_STATS.keptTargets = keptTargets;
  const rate = linkRows > 0 ? resolvedTargets / linkRows : 0;
  INGEST_STATS.targetResolution = rate;
  console.log(`cl_target_id -> lt_title resolution: ${resolvedTargets}/${linkRows} (${(rate*100).toFixed(2)}%)`);
  if (linkRows > 0) {
    console.log(`meta filter kept ${keptTargets}/${linkRows} targets (${(100 * keptTargets / linkRows).toFixed(2)}% of links)`);
  }

  db.close();

  if (rate < MIN_TARGET_RESOLUTION) {
    throw new Error(
      `Only ${(rate*100).toFixed(2)}% of categorylinks rows resolved to a category ` +
      `(< ${(MIN_TARGET_RESOLUTION*100).toFixed(0)}% required). A linktarget dump from a ` +
      `different snapshot date than categorylinks is the usual cause. Download all four ` +
      `dumps (page, linktarget, categorylinks, category) from ONE dated directory, e.g. ` +
      `https://dumps.wikimedia.org/enwiki/20260801/.`,
    );
  }
  if (INGEST_STATS.keptMembers === 0) {
    throw new Error('ingest produced zero member rows');
  }

  return INGEST_STATS;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = missingInputs();
  if (missing.length) {
    console.error('Missing input dumps:');
    missing.forEach(p => console.error('  ' + p));
    process.exit(1);
  }
  ingest()
    .then(s => { console.log('ingest complete'); console.table(s); })
    .catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 12: Run all script tests**

Run: `npx vitest run scripts/`
Expected: PASS — 17 tests across three files.

- [ ] **Step 13: Verify ingest against the fixture**

```bash
node -e "
const { gzipSync } = require('node:zlib');
const { readFileSync, writeFileSync } = require('node:fs');
const sql = readFileSync('scripts/fixtures/mini-dump.sql', 'utf8');
writeFileSync('scripts/fixtures/mini.sql.gz', gzipSync(Buffer.from(sql, 'utf8')));
" && node --input-type=module -e "
import { ingest } from './scripts/ingest.mjs';
import { PATHS } from './scripts/ingest.mjs';
PATHS.page = 'scripts/fixtures/mini.sql.gz';
PATHS.categorylinks = 'scripts/fixtures/mini.sql.gz';
const s = await ingest();
console.log(JSON.stringify(s, null, 2));
"
```

Expected: `rawCategories` 3 — `Physical sciences`, `Thermodynamics`, `Information theory`. The two `CS1` categories are filtered. `keptParents` 3, `keptMembers` 4.

**If these counts differ, the namespace check or the meta filter is wrong. Do not proceed until they match.**

- [ ] **Step 14: Commit**

```bash
git add scripts
git commit -m "feat(scripts): streaming sql parser, category filter, sqlite ingest"
```

---

## Task 4: Prune pass 1 — meta filter

**Files:**
- Create: `scripts/lib/prune.mjs`
- Test: `scripts/lib/__tests__/prune-meta.test.mjs`

**Interfaces:**
- Consumes: `isMaintenanceCategory` from Task 3.
- Produces: `export function applyMetaFilter(names: string[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/__tests__/prune-meta.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { applyMetaFilter } from '../prune.mjs';

describe('applyMetaFilter', () => {
  it('removes maintenance categories', () => {
    expect(applyMetaFilter(['Physics', 'CS1 references', 'WikiProject Foo', 'Thermodynamics']))
      .toEqual(['Physics', 'Thermodynamics']);
  });
  it('removes bare years and year spans but keeps years inside names', () => {
    expect(applyMetaFilter(['1900', '1990s', 'Films of 1999', 'Medicine']))
      .toEqual(['Films of 1999', 'Medicine']);
  });
  it('preserves input order', () => {
    expect(applyMetaFilter(['Zebra', 'CS1 x', 'Apple'])).toEqual(['Zebra', 'Apple']);
  });
  it('drops empties and whitespace-only names', () => {
    expect(applyMetaFilter(['', '   ', 'Physics'])).toEqual(['Physics']);
  });
  it('returns a new array and does not mutate the input', () => {
    const input = ['Physics', 'CS1 x'];
    const out = applyMetaFilter(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(['Physics', 'CS1 x']);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/prune-meta.test.mjs`
Expected: FAIL — `Cannot find module '../prune.mjs'`.

- [ ] **Step 3: Implement pass 1**

Create `scripts/lib/prune.mjs`:

```js
import { isMaintenanceCategory } from './categories.mjs';

/** Pass 1. Needs no graph structure, so it runs first on the raw name list. */
export function applyMetaFilter(names) {
  return names.filter(name => {
    const trimmed = name.trim();
    return trimmed.length > 0 && !isMaintenanceCategory(trimmed);
  });
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run scripts/lib/__tests__/prune-meta.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/prune.mjs scripts/lib/__tests__/prune-meta.test.mjs
git commit -m "feat(scripts): prune pass 1, meta filter"
```

---

## Task 5: Prune pass 2 — primary parent selection and cycle breaking

**Files:**
- Modify: `scripts/lib/prune.mjs`
- Test: `scripts/lib/__tests__/prune-parent.test.mjs`

**Interfaces:**
- Consumes: `applyMetaFilter` (Task 4).
- Produces:
  ```js
  export function computeSubtreeSizes(children, nodeCount)    // -> Int32Array
  export function selectPrimaryParents(parentsByChild, nodeCount)
  //   -> { primary: Int32Array, demoted: Array<{child,parent}>, sizes: Int32Array }
  export function breakCycles(primary, demoted, nodeCount)     // -> Int32Array
  export function assignDepth(parentOf, nodeCount)             // -> Int32Array, -1 when unreachable
  ```

**Order matters:** depth is undefined until primary parents are assigned, so this task must complete before Task 6. See spec section 4.2.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/__tests__/prune-parent.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import {
  computeSubtreeSizes, selectPrimaryParents, breakCycles, assignDepth,
} from '../prune.mjs';

describe('computeSubtreeSizes', () => {
  it('counts a node and everything beneath it', () => {
    // 0 -> 1 -> 2, plus 0 -> 3
    const sizes = computeSubtreeSizes([[1, 3], [2], [], []], 4);
    expect(Array.from(sizes)).toEqual([4, 2, 1, 1]);
  });
});

describe('selectPrimaryParents', () => {
  it('picks the parent with the largest subtree', () => {
    //     2      3
    //    / \     |
    //   4   5    6
    //  / \   \
    // 7   8   9
    const parentsByChild = [[], [], [1], [1], [2], [2], [4], [4], [5]];
    const { primary } = selectPrimaryParents(parentsByChild, 9);
    expect(primary[2]).toBe(1);
    expect(primary[3]).toBe(1);
  });

  it('demotes the losing candidates', () => {
    const { primary, demoted } = selectPrimaryParents([[], [], [1, 0], [], []], 4);
    expect(primary[2]).toBe(0);
    expect(demoted).toEqual([{ child: 2, parent: 1 }]);
  });

  it('is deterministic across runs', () => {
    const a = selectPrimaryParents([[], [], [1, 0], [], []], 4).primary;
    const b = selectPrimaryParents([[], [], [1, 0], [], []], 4).primary;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('leaves a node with no parents as a root', () => {
    const { primary } = selectPrimaryParents([[], [], [1], []], 4);
    expect(primary[0]).toBe(-1);
    expect(primary[1]).toBe(-1);
  });
});

describe('breakCycles', () => {
  it('breaks a two-node cycle', () => {
    const fixed = breakCycles(Int32Array.from([1, 0, -1, 1]), [], 4);
    expect(fixed[0]).toBe(-1);
    expect(fixed[1]).toBe(0);
  });
  it('breaks a three-node cycle', () => {
    const fixed = breakCycles(Int32Array.from([1, 2, 0, -1]), [], 4);
    expect(fixed[0]).toBe(-1);
    expect(fixed[1]).toBe(0);
    expect(fixed[2]).toBe(1);
  });
  it('leaves an acyclic forest untouched', () => {
    const primary = Int32Array.from([-1, 0, 1, 0]);
    expect(Array.from(breakCycles(primary, [], 4))).toEqual(Array.from(primary));
  });
});

describe('assignDepth', () => {
  it('assigns depth from the roots', () => {
    expect(Array.from(assignDepth(Int32Array.from([-1, 0, 1, 0]), 4))).toEqual([0, 1, 2, 1]);
  });
  it('marks nodes unreachable from any root as -1', () => {
    const depths = Array.from(assignDepth(Int32Array.from([-1, 2, 1, 1]), 4));
    expect(depths[0]).toBe(0);
    expect(depths[3]).toBe(-1);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/prune-parent.test.mjs`
Expected: FAIL — `computeSubtreeSizes is not a function`.

- [ ] **Step 3: Implement pass 2**

Append to `scripts/lib/prune.mjs`:

```js
/** Bottom-up subtree sizes. `children[i]` lists i's child indices. */
export function computeSubtreeSizes(children, nodeCount) {
  const sizes = new Int32Array(nodeCount).fill(1);
  const state = new Uint8Array(nodeCount);
  const stack = [];
  for (let start = 0; start < nodeCount; start++) {
    if (state[start]) continue;
    stack.push(start);
    while (stack.length) {
      const node = stack[stack.length - 1];
      if (state[node] === 0) {
        state[node] = 1;
        for (const child of children[node]) if (state[child] === 0) stack.push(child);
      } else {
        stack.pop();
        if (state[node] === 2) continue;
        state[node] = 2;
        for (const child of children[node]) sizes[node] += sizes[child];
      }
    }
  }
  return sizes;
}

/**
 * Pass 2. Choose one primary parent per node: largest subtree wins, then the
 * lower index as a deterministic tie-break. Losers become cross-links.
 *
 * Subtree sizes are measured on the immediate-child graph, not full DAG
 * reachability. On Wikipedia's category graph the two agree closely and this
 * is O(V+E) instead of a transitive closure.
 */
export function selectPrimaryParents(parentsByChild, nodeCount) {
  const childLists = Array.from({ length: nodeCount }, () => []);
  parentsByChild.forEach((parents, child) => {
    for (const p of parents) childLists[p].push(child);
  });
  const sizes = computeSubtreeSizes(childLists, nodeCount);

  const primary = new Int32Array(nodeCount).fill(-1);
  const demoted = [];
  for (let child = 0; child < nodeCount; child++) {
    const candidates = parentsByChild[child];
    if (!candidates || candidates.length === 0) continue;
    const sorted = [...candidates].sort((a, b) => (sizes[b] - sizes[a]) || (a - b));
    primary[child] = sorted[0];
    for (const p of sorted.slice(1)) demoted.push({ child, parent: p });
  }
  return { primary, demoted, sizes };
}

/**
 * Remove cycles from the primary-parent assignment. Within each cycle the
 * lowest-indexed member is detached and becomes a root; its edge joins the
 * demoted set so the relationship survives as a cross-link.
 */
export function breakCycles(primary, demoted, nodeCount) {
  const parentOf = Int32Array.from(primary);
  const state = new Uint8Array(nodeCount);
  const fixed = Int32Array.from(parentOf);

  for (let start = 0; start < nodeCount; start++) {
    if (state[start]) continue;
    const path = [];
    let node = start;
    while (node !== -1 && state[node] === 0) {
      state[node] = 1;
      path.push(node);
      node = parentOf[node];
    }
    if (node !== -1 && state[node] === 1) {
      const cycle = path.slice(path.indexOf(node));
      const victim = Math.min(...cycle);
      const victimParent = parentOf[victim];
      fixed[victim] = -1;
      if (victimParent !== -1) demoted.push({ child: victim, parent: victimParent });
    }
    for (const n of path) state[n] = 2;
  }
  return fixed;
}

/** Depth from the roots. -1 marks nodes unreachable from any root. */
export function assignDepth(parentOf, nodeCount) {
  const children = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < nodeCount; i++) if (parentOf[i] !== -1) children[parentOf[i]].push(i);
  const depth = new Int32Array(nodeCount).fill(-1);
  const stack = [];
  for (let i = 0; i < nodeCount; i++) {
    if (parentOf[i] === -1) { depth[i] = 0; stack.push(i); }
  }
  while (stack.length) {
    const node = stack.pop();
    for (const child of children[node]) {
      if (depth[child] === -1) { depth[child] = depth[node] + 1; stack.push(child); }
    }
  }
  return depth;
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run scripts/lib/__tests__/prune-parent.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/prune.mjs scripts/lib/__tests__/prune-parent.test.mjs
git commit -m "feat(scripts): prune pass 2, primary parent selection and cycle breaking"
```

---

## Task 6: Prune passes 3–5, emission, and `meta.json`

**Files:**
- Modify: `scripts/lib/prune.mjs`
- Create: `scripts/lib/emit.mjs`
- Test: `scripts/lib/__tests__/prune-cut.test.mjs`, `emit.test.mjs`

**Interfaces:**
- Consumes: Task 5 functions.
- Produces:
  ```js
  export function capDepth(parentOf, nodeCount, maxDepth)  // -> { parentOf, removedCount }
  export function rankAndCut(parentOf, depth, articleCount, nodeCount, target)
  //   -> { kept: Uint8Array, restoredCount: number }
  export function assertAcyclic(parentOf, nodeCount)       // -> Int32Array depths, throws on a cycle

  export function buildConceptsFile(nodes, dumpDate, version)
  export function buildCrosslinksFile(edges)
  export function buildMeta(counts, params, dumpDate, version, generatedAt)
  export const DEFAULT_SOURCES
  ```

- [ ] **Step 1: Write the failing depth-cap and cut test**

Create `scripts/lib/__tests__/prune-cut.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { capDepth, rankAndCut, assertAcyclic } from '../prune.mjs';

describe('capDepth', () => {
  it('re-parents a depth-6 node to its depth-5 ancestor', () => {
    const { parentOf: capped } = capDepth(Int32Array.from([-1, 0, 1, 2, 3, 4, 5]), 7, 5);
    expect(capped[5]).toBe(4);
    expect(capped[6]).toBe(4);
  });
  it('counts the removed node', () => {
    expect(capDepth(Int32Array.from([-1, 0, 1, 2, 3, 4, 5]), 7, 5).removedCount).toBe(1);
  });
  it('leaves a shallow tree untouched', () => {
    const { parentOf: capped, removedCount } = capDepth(Int32Array.from([-1, 0, 0]), 3, 5);
    expect(Array.from(capped)).toEqual([-1, 0, 0]);
    expect(removedCount).toBe(0);
  });
});

describe('rankAndCut', () => {
  it('keeps the top N by articleCount', () => {
    // counts 10, 90, 50, 20 -> keep 2: index 1 (90) and index 2 (50)
    const { kept } = rankAndCut(
      Int32Array.from([-1, 0, 0, 0]), Int32Array.from([0, 1, 1, 1]), [10, 90, 50, 20], 4, 2,
    );
    expect(Array.from(kept)).toEqual([1, 0, 1, 0]);
  });
  it('restores ancestors needed to keep a kept node reachable', () => {
    const { kept, restoredCount } = rankAndCut(
      Int32Array.from([-1, 0, 1, 2]), Int32Array.from([0, 1, 2, 3]), [1, 2, 3, 9999], 4, 1,
    );
    expect(Array.from(kept)).toEqual([1, 1, 1, 1]);
    expect(restoredCount).toBe(3);
  });
});

describe('assertAcyclic', () => {
  it('passes on an acyclic forest', () => {
    expect(() => assertAcyclic(Int32Array.from([-1, 0, 1]), 3)).not.toThrow();
  });
  it('throws on a cycle', () => {
    expect(() => assertAcyclic(Int32Array.from([1, 0]), 2)).toThrow(/cycle/i);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/prune-cut.test.mjs`
Expected: FAIL — `capDepth is not a function`.

- [ ] **Step 3: Implement passes 3–5**

Append to `scripts/lib/prune.mjs`:

```js
/**
 * Pass 3. Re-parent any node deeper than maxDepth to the ancestor sitting at
 * maxDepth, then drop it. Re-parenting to that anchor preserves connectivity.
 */
export function capDepth(parentOf, nodeCount, maxDepth) {
  const next = Int32Array.from(parentOf);
  const depth = assignDepth(next, nodeCount);
  let removedCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (depth[i] <= maxDepth) continue;
    const chain = [];
    let node = i;
    while (node !== -1 && depth[node] > maxDepth) { chain.push(node); node = next[node]; }
    for (const n of chain) { next[n] = node; removedCount++; }
  }
  return { parentOf: next, removedCount };
}

/**
 * Passes 4 and 5. Keep the top `target` nodes by articleCount, then pull back
 * any ancestor needed to keep a kept node reachable from a root.
 */
export function rankAndCut(parentOf, depth, articleCount, nodeCount, target) {
  const order = Array.from({ length: nodeCount }, (_, i) => i)
    .filter(i => depth[i] >= 0)
    .sort((a, b) => (articleCount[b] - articleCount[a]) || (a - b));

  const kept = new Uint8Array(nodeCount);
  let keptCount = 0;
  for (const i of order) {
    if (keptCount >= target) break;
    kept[i] = 1;
    keptCount++;
  }

  let restoredCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (!kept[i]) continue;
    let node = parentOf[i];
    while (node !== -1 && !kept[node]) { kept[node] = 1; restoredCount++; node = parentOf[node]; }
  }
  return { kept, restoredCount };
}

/** Throws if any node is unreachable from a root, i.e. a cycle survived. */
export function assertAcyclic(parentOf, nodeCount) {
  const depth = assignDepth(parentOf, nodeCount);
  const unreachable = [];
  for (let i = 0; i < nodeCount; i++) if (depth[i] < 0) unreachable.push(i);
  if (unreachable.length) {
    throw new Error(
      `cycle survived pruning: ${unreachable.length} node(s) unreachable from any root ` +
      `(first: ${unreachable.slice(0, 5).join(', ')})`,
    );
  }
  return depth;
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run scripts/lib/__tests__/prune-cut.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing emit test**

Create `scripts/lib/__tests__/emit.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { buildConceptsFile, buildCrosslinksFile, buildMeta } from '../emit.mjs';
import { loadConcepts, loadCrosslinks, loadMeta } from '../../../src/lib/artifacts/load';

const nodes = [
  { id: 'physics', name: 'Physics', parent: -1, depth: 0, articleCount: 100, aliases: [] },
  { id: 'thermo', name: 'Thermodynamics', parent: 0, depth: 1, articleCount: 50, aliases: [] },
];

describe('buildConceptsFile', () => {
  it('round-trips through the frontend validator', () => {
    const f = buildConceptsFile(nodes, '2026-08-05', '1');
    expect(() => loadConcepts(JSON.parse(JSON.stringify(f)))).not.toThrow();
  });
  it('sets nodeCount from the array length', () => {
    expect(buildConceptsFile(nodes, '2026-08-05', '1').nodeCount).toBe(2);
  });
  it('uses compact parent indices, not id strings', () => {
    expect(buildConceptsFile(nodes, '2026-08-05', '1').nodes[1].parent).toBe(0);
  });
});

describe('buildCrosslinksFile', () => {
  it('round-trips through the frontend validator', () => {
    const f = buildCrosslinksFile([{ a: 0, b: 1, shared: 7 }]);
    expect(() => loadCrosslinks(JSON.parse(JSON.stringify(f)))).not.toThrow();
  });
});

describe('buildMeta', () => {
  it('round-trips and records every parameter', () => {
    const meta = buildMeta(
      { rawCategories: 4000000, afterMetaFilter: 90000, afterDepthCap: 45000,
        finalNodes: 30000, restoredAncestors: 400, crosslinks: 120000,
        danglingCrosslinks: 0 },
      { nodeTarget: 30000, maxDepth: 5, crosslinkMinArticleCount: 10,
        crosslinkMinShared: 3, crosslinkTopK: 20, crosslinkGlobalCap: 400000,
        crosslinkMemberSample: 200, metaFilterPatterns: ['^CS\\d'] },
      '2026-08-05', '1', '2026-10-11T00:00:00Z',
    );
    expect(() => loadMeta(JSON.parse(JSON.stringify(meta)))).not.toThrow();
    expect(meta.counts.finalNodes).toBe(30000);
    expect(meta.params.metaFilterPatterns).toEqual(['^CS\\d']);
    expect(meta.sources.every(s => /^https?:\/\//.test(s.url))).toBe(true);
  });
});
```

- [ ] **Step 6: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/emit.test.mjs`
Expected: FAIL — `Cannot find module '../emit.mjs'`.

- [ ] **Step 7: Implement emit**

Create `scripts/lib/emit.mjs`:

```js
import { slugify } from './slug.mjs';

export function buildConceptsFile(nodes, dumpDate, version) {
  return {
    version,
    dumpDate,
    nodeCount: nodes.length,
    nodes: nodes.map(n => ({
      id: n.id ?? slugify(n.name),
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

export function buildMeta(counts, params, dumpDate, version, generatedAt) {
  return { version, generatedAt, dumpDate, counts, params, sources: DEFAULT_SOURCES };
}
```

- [ ] **Step 8: Run every unit test**

Run: `npx vitest run`
Expected: PASS — 40 tests across 6 files.

- [ ] **Step 9: Commit**

```bash
git add scripts
git commit -m "feat(scripts): prune passes 3-5 and artifact emission"
```

---

## Task 7: Cross-link computation

**Files:**
- Create: `scripts/crosslink.mjs`
- Test: `scripts/lib/__tests__/crosslink.test.mjs`

**Interfaces:**
- Consumes: the SQLite database from Task 3.
- Produces:
  ```js
  export function selectMemberSample(db, minArticleCount, sample)  // -> Map<number, Set<string>>
  export function countSharedPairs(samples, minShared)            // -> Map<string,{a,b,shared}>
  export function truncateTopK(pairs, topK, globalCap)            // -> Array<{a,b,shared}>
  export function crosslink(dbPath, params)                       // -> Array<{a,b,shared}>
  export const DEFAULTS
  ```

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/__tests__/crosslink.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { countSharedPairs, truncateTopK } from '../../crosslink.mjs';

const sample = entries => new Map(entries.map(([cat, arts]) => [cat, new Set(arts)]));

describe('countSharedPairs', () => {
  it('rejects a pair below the threshold', () => {
    const s = sample([[1, ['a', 'b', 'c']], [2, ['b', 'c', 'd']]]);
    expect(countSharedPairs(s, 3).size).toBe(0);
  });
  it('emits a pair once the shared count reaches the threshold', () => {
    const s = sample([[1, ['a', 'b', 'c', 'd']], [2, ['b', 'c', 'd', 'e']]]);
    const [[key, val]] = [...countSharedPairs(s, 3)];
    expect(key).toBe('1:2');
    expect(val).toEqual({ a: 1, b: 2, shared: 3 });
  });
  it('always stores the lower index first', () => {
    const s = sample([[7, ['x', 'y', 'z']], [2, ['x', 'y', 'z']]]);
    const [[key, val]] = [...countSharedPairs(s, 3)];
    expect(key).toBe('2:7');
    expect(val.a).toBeLessThan(val.b);
  });
  it('never pairs a category with itself', () => {
    expect(countSharedPairs(sample([[1, ['a', 'b', 'c']]]), 1).size).toBe(0);
  });
  it('counts a three-way shared article once per pair', () => {
    const s = sample([[1, ['x', 'y', 'z']], [2, ['x', 'y', 'z']], [3, ['x', 'y', 'z']]]);
    expect(countSharedPairs(s, 3).size).toBe(3);
  });
  it('aggregates shared articles across several articles', () => {
    const s = sample([[1, ['x', 'y']], [2, ['x', 'y']]]);
    expect([...countSharedPairs(s, 2)][0][1].shared).toBe(2);
  });
});

describe('truncateTopK', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ a: 0, b: i + 1, shared: 100 - i }));

  it('keeps at most topK edges at a node', () => {
    const out = truncateTopK(many, 20, 400000);
    expect(out.filter(e => e.a === 0 || e.b === 0)).toHaveLength(20);
  });
  it('keeps the highest-shared edges', () => {
    const out = truncateTopK(many, 20, 400000);
    expect(out.filter(e => e.a === 0 || e.b === 0)[0].shared).toBe(100);
  });
  it('applies the global cap last', () => {
    expect(truncateTopK(many, 30, 5)).toHaveLength(5);
  });
  it('is deterministic for equal weights', () => {
    const tied = [{ a: 0, b: 1, shared: 5 }, { a: 0, b: 2, shared: 5 }];
    expect(truncateTopK(tied, 1, 100)).toEqual([{ a: 0, b: 1, shared: 5 }]);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/crosslink.test.mjs`
Expected: FAIL — `Cannot find module '../../crosslink.mjs'`.

- [ ] **Step 3: Implement cross-link computation**

Create `scripts/crosslink.mjs`:

```js
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  minArticleCount: 10,
  minShared: 3,
  topK: 20,
  globalCap: 400_000,
  memberSample: 200,
};

/** Cat ids with enough articles to have meaningful neighbours, plus a sample of each. */
export function selectMemberSample(db, minArticleCount, sample) {
  // cat_pages is MediaWiki's own authoritative count. Counting member rows is
  // badly wrong: member holds only rows that survived the meta filter, so a
  // category like "Unprintworthy redirects" (1.97M pages, filtered away)
  // would read as near-empty.
  const eligible = db.prepare('SELECT id FROM cat WHERE cat_pages >= ?').all(minArticleCount).map(r => r.id);
  const stmt = db.prepare('SELECT article FROM member WHERE cat = ? LIMIT ?');
  const samples = new Map();
  for (const id of eligible) samples.set(id, new Set(stmt.all(id, sample).map(r => r.article)));
  return samples;
}

/** For each article, emit every unordered pair of the categories holding it. a < b always. */
export function countSharedPairs(samples, minShared) {
  const articleToCats = new Map();
  for (const [cat, articles] of samples) {
    for (const article of articles) {
      let list = articleToCats.get(article);
      if (!list) articleToCats.set(article, (list = []));
      list.push(cat);
    }
  }

  const pairs = new Map();
  for (const cats of articleToCats.values()) {
    for (let i = 0; i < cats.length; i++) {
      for (let j = i + 1; j < cats.length; j++) {
        const a = Math.min(cats[i], cats[j]);
        const b = Math.max(cats[i], cats[j]);
        if (a === b) continue;
        const key = `${a}:${b}`;
        const existing = pairs.get(key);
        if (existing) existing.shared++;
        else pairs.set(key, { a, b, shared: 1 });
      }
    }
  }
  for (const [key, val] of pairs) if (val.shared < minShared) pairs.delete(key);
  return pairs;
}

/** Keep the topK strongest edges at each endpoint, then apply the global cap. */
export function truncateTopK(pairs, topK, globalCap) {
  const degree = new Map();
  for (const e of pairs.values()) {
    for (const node of [e.a, e.b]) {
      if (!degree.has(node)) degree.set(node, []);
      degree.get(node).push(e);
    }
  }

  const keep = new Set();
  for (const list of degree.values()) {
    list
      .sort((x, y) => (y.shared - x.shared) || (Math.min(x.a, x.b) - Math.min(y.a, y.b)))
      .slice(0, topK)
      .forEach(e => keep.add(`${e.a}:${e.b}`));
  }

  const out = [];
  for (const key of keep) {
    const e = pairs.get(key);
    if (e) out.push(e);
  }
  out.sort((x, y) => (x.a - y.a) || (x.b - y.b));
  return out.slice(0, globalCap);
}

export function crosslink(dbPath, params = {}) {
  const p = { ...DEFAULTS, ...params };
  if (!existsSync(dbPath)) {
    throw new Error(`crosslink: database not found at ${dbPath}. Run npm run ingest first.`);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const samples = selectMemberSample(db, p.minArticleCount, p.memberSample);
    return truncateTopK(countSharedPairs(samples, p.minShared), p.topK, p.globalCap);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`crosslinks: ${crosslink(resolve(ROOT, 'atlas-work/atlas.db')).length} edges`);
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run scripts/lib/__tests__/crosslink.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/crosslink.mjs scripts/lib/__tests__/crosslink.test.mjs
git commit -m "feat(scripts): article co-occurrence cross-link layer"
```

---

## Task 8: Precomputed force layout

**Files:**
- Create: `scripts/layout.mjs`
- Test: `scripts/lib/__tests__/layout.test.mjs`

**Interfaces:**
- Consumes: nodes with `parent`, `depth`, `articleCount`.
- Produces:
  ```js
  export function seededRandom(seed)          // -> () => number in [0,1)
  export function computePositions(nodes, opts) // -> { x, y, treeSrc, treeDst }
  export function packLayout(positions, crosslinks)  // -> ArrayBuffer
  export function layoutInputHash(nodes)        // -> string, 16 hex chars
  export const LAYOUT_OPTS
  ```

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/__tests__/layout.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { computePositions, packLayout, layoutInputHash } from '../../layout.mjs';

const nodes = [
  { id: 'a', name: 'A', parent: -1, depth: 0, articleCount: 100 },
  { id: 'b', name: 'B', parent: 0, depth: 1, articleCount: 50 },
  { id: 'c', name: 'C', parent: 0, depth: 1, articleCount: 25 },
];

describe('computePositions', () => {
  it('returns one position per node', () => {
    const p = computePositions(nodes);
    expect(p.x).toHaveLength(3);
    expect(p.y).toHaveLength(3);
  });
  it('produces finite coordinates for every node', () => {
    const p = computePositions(nodes);
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(p.x[i])).toBe(true);
      expect(Number.isFinite(p.y[i])).toBe(true);
    }
  });
  it('is deterministic for identical input', () => {
    expect(Array.from(computePositions(nodes).x)).toEqual(Array.from(computePositions(nodes).x));
  });
  it('emits one tree edge per non-root node', () => {
    const p = computePositions(nodes);
    expect(p.treeSrc).toHaveLength(2);
    expect(p.treeDst).toHaveLength(2);
  });
});

describe('packLayout', () => {
  it('produces a buffer the frontend parser accepts', () => {
    // 3 nodes * 8 bytes + 2 tree edges * 4 bytes + 0 crosslinks
    expect(packLayout(computePositions(nodes), []).byteLength).toBe(3 * 8 + 2 * 4);
  });
  it('appends crosslink sections when present', () => {
    const buf = packLayout(computePositions(nodes), [{ a: 1, b: 2, shared: 4 }]);
    expect(buf.byteLength).toBe(3 * 8 + 2 * 4 + 8);
  });
  it('round-trips through parseLayout with the correct rootCount', () => {
    const buf = packLayout(computePositions(nodes), []);
    const parsed = parseLayout(buf, 3, 1, 0);
    expect(parsed.x).toHaveLength(3);
    expect(parsed.treeSrc).toHaveLength(2);
  });
  it('throws when the edge count implies zero roots', () => {
    const p = computePositions(nodes);
    expect(() => packLayout({ ...p, treeSrc: new Uint16Array(3), treeDst: new Uint16Array(3) }, []))
      .toThrow(/root/i);
  });
});

describe('layoutInputHash', () => {
  it('changes when the node set changes', () => {
    const changed = [{ ...nodes[0], articleCount: 101 }, nodes[1], nodes[2]];
    expect(layoutInputHash(nodes)).not.toBe(layoutInputHash(changed));
  });
  it('is stable for identical input', () => {
    expect(layoutInputHash(nodes)).toBe(layoutInputHash(nodes));
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/layout.test.mjs`
Expected: FAIL — `Cannot find module '../../layout.mjs'`.

- [ ] **Step 3: Implement the layout script**

Create `scripts/layout.mjs`:

```js
import { createHash } from 'node:crypto';
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
} from 'd3-force';

export const LAYOUT_OPTS = {
  ticks: 150,
  theta: 0.9,
  alphaDecay: 0.05,
  distance: 90,
  chargeStrength: -260,
};

/** Mulberry32: small, fast, and reproducible across Node versions. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computePositions(nodes, opts = {}) {
  const o = { ...LAYOUT_OPTS, ...opts };

  // Seed by depth so the simulation starts near a sane structure and settles
  // in far fewer ticks than a random start would need.
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0) || 1;
  const simNodes = nodes.map((n, i) => {
    const angle = seededRandom(i + 1)() * Math.PI * 2;
    const radius = 120 + n.depth * (900 / maxDepth);
    return { index: i, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });

  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].parent >= 0) links.push({ source: nodes[i].parent, target: i });
  }

  const simulation = forceSimulation(simNodes)
    .randomSource(seededRandom(42))
    .force('link', forceLink(links).id(d => d.index).distance(o.distance))
    .force('charge', forceManyBody().strength(o.chargeStrength))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide().radius(0))
    .stop()
    .alphaDecay(o.alphaDecay)
    .theta(o.theta);

  simulation.tick(o.ticks);

  const x = new Float32Array(nodes.length);
  const y = new Float32Array(nodes.length);
  const byIndex = new Map(simNodes.map(d => [d.index, d]));
  for (let i = 0; i < nodes.length; i++) {
    x[i] = byIndex.get(i).x;
    y[i] = byIndex.get(i).y;
  }

  const treeSrc = new Uint16Array(links.length);
  const treeDst = new Uint16Array(links.length);
  links.forEach((l, i) => {
    treeSrc[i] = typeof l.source === 'object' ? l.source.index : l.source;
    treeDst[i] = typeof l.target === 'object' ? l.target.index : l.target;
  });

  return { x, y, treeSrc, treeDst };
}

/** Section order is fixed by spec section 4.5 and must match parseLayout. */
export function packLayout(positions, crosslinks) {
  const { x, y, treeSrc, treeDst } = positions;
  // The tree is a forest: tree edges = nodeCount - rootCount, which must equal
  // the number of links actually emitted. A mismatch means a node's parent
  // index is missing or duplicated upstream.
  const rootCount = x.length - treeSrc.length;
  if (rootCount < 1) {
    throw new Error(`layout: ${x.length} nodes with ${treeSrc.length} tree edges implies ${rootCount} roots`);
  }
  const n = crosslinks.length;
  const crossSrc = new Uint16Array(n);
  const crossDst = new Uint16Array(n);
  const crossWeight = new Float32Array(n);
  crosslinks.forEach((e, i) => { crossSrc[i] = e.a; crossDst[i] = e.b; crossWeight[i] = e.shared; });

  const buf = new ArrayBuffer(
    x.byteLength + y.byteLength + treeSrc.byteLength + treeDst.byteLength
    + crossSrc.byteLength + crossDst.byteLength + crossWeight.byteLength,
  );
  const parts = [x, y, treeSrc, treeDst, crossSrc, crossDst, crossWeight];
  let offset = 0;
  for (const p of parts) {
    new Uint8Array(buf, offset, p.byteLength)
      .set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    offset += p.byteLength;
  }
  return buf;
}

export function layoutInputHash(nodes) {
  const h = createHash('sha256');
  for (const n of nodes) h.update(`${n.id}\u0000${n.parent}\u0000${n.articleCount}\u0000`);
  return h.digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run scripts/lib/__tests__/layout.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/layout.mjs scripts/lib/__tests__/layout.test.mjs
git commit -m "feat(scripts): deterministic precomputed force layout"
```

---

## Task 9: Pipeline orchestrator and the real run

**Files:**
- Create: `scripts/build-artifacts.mjs`
- Test: `scripts/lib/__tests__/pipeline.test.mjs`

**Interfaces:**
- Consumes: every `scripts/` module from Tasks 3–8.
- Produces: `src/data/artifacts/{concepts.json,crosslinks.json,layout.bin,meta.json}`.

- [ ] **Step 1: Write the failing end-to-end fixture test**

Create `scripts/lib/__tests__/pipeline.test.mjs`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../../build-artifacts.mjs';
import { loadConcepts, loadCrosslinks, parseLayout } from '../../../src/lib/artifacts/load';

const PARAMS = {
  nodeTarget: 3, maxDepth: 5,
  crosslinkMinArticleCount: 1, crosslinkMinShared: 1,
  crosslinkTopK: 20, crosslinkGlobalCap: 1000, crosslinkMemberSample: 200,
  metaFilterPatterns: [],
};

let result;

beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'atlas-pipeline-'));
  result = await buildAll({
    outDir,
    dbPath: join(outDir, 'test.db'),
    buildDb: async () => {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(join(outDir, 'test.db'));
      db.exec('CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
      db.exec('CREATE TABLE parent (child INTEGER NOT NULL, parent INTEGER NOT NULL)');
      db.exec('CREATE TABLE member (article TEXT NOT NULL, cat INTEGER NOT NULL)');
      const insCat = db.prepare('INSERT INTO cat(id,name) VALUES (?,?)');
      const insParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
      const insMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');
      // 1 Natural sciences (root)
      //   2 Physics   3 Thermodynamics   4 Information theory   5 Chemistry
      // 6 CS1 references is filtered upstream and must not appear
      insCat.run(1, 'Natural sciences');
      insCat.run(2, 'Physics');
      insCat.run(3, 'Thermodynamics');
      insCat.run(4, 'Information theory');
      insCat.run(5, 'Chemistry');
      insCat.run(6, 'CS1 references');
      insParent.run(2, 1); insParent.run(3, 2); insParent.run(4, 1); insParent.run(5, 1);
      for (const a of ['e1', 'e2', 'e3']) insMember.run(a, 3);
      for (const a of ['e1', 'e2', 'e3', 'e9']) insMember.run(a, 4);
      insMember.run('c1', 2); insMember.run('c2', 2); insMember.run('c3', 2);
      insMember.run('c1', 5);
      db.close();
    },
    params: PARAMS,
  });
}, 30_000);

describe('buildAll end to end', () => {
  it('produces every artifact file', () => {
    for (const f of ['concepts.json', 'crosslinks.json', 'layout.bin', 'meta.json']) {
      expect(result.files[f]).toBe(true);
    }
  });
  it('emits concepts that pass frontend validation', () => {
    expect(() => loadConcepts(result.concepts)).not.toThrow();
  });
  it('emits crosslinks that pass frontend validation', () => {
    expect(() => loadCrosslinks(result.crosslinks)).not.toThrow();
  });
  it('emits a layout whose byte length matches the declared node count', () => {
    const c = loadConcepts(result.concepts);
    const x = loadCrosslinks(result.crosslinks);
    // The tree is a forest: derive rootCount, never assume 1.
    const rootCount = c.nodes.filter(n => n.parent === -1).length;
    expect(parseLayout(result.layoutBuffer, c.nodeCount, rootCount, x.edges.length).x)
      .toHaveLength(c.nodeCount);
  });
  it('filters the CS1 maintenance category', () => {
    expect(result.concepts.nodes.map(n => n.name)).not.toContain('CS1 references');
  });
  it('finds the Thermodynamics / Information theory cross-link', () => {
    const byName = new Map(result.concepts.nodes.map((n, i) => [n.name, i]));
    const a = byName.get('Thermodynamics');
    const b = byName.get('Information theory');
    expect(result.crosslinks.edges.some(
      e => (e.a === a && e.b === b) || (e.a === b && e.b === a),
    )).toBe(true);
  });
  it('respects the node target', () => {
    expect(result.concepts.nodes.length).toBeLessThanOrEqual(PARAMS.nodeTarget + 5);
  });
  it('keeps every node within the depth cap', () => {
    expect(Math.max(...result.concepts.nodes.map(n => n.depth))).toBeLessThanOrEqual(PARAMS.maxDepth);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run scripts/lib/__tests__/pipeline.test.mjs`
Expected: FAIL — `Cannot find module '../../build-artifacts.mjs'`.

- [ ] **Step 3: Implement the orchestrator**

Create `scripts/build-artifacts.mjs`:

```js
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  applyMetaFilter, selectPrimaryParents, breakCycles, capDepth,
  rankAndCut, assertAcyclic, assignDepth,
} from './lib/prune.mjs';
import { MAINTENANCE_PATTERNS } from './lib/categories.mjs';
import { buildConceptsFile, buildCrosslinksFile, buildMeta } from './lib/emit.mjs';
import { slugify } from './lib/slug.mjs';
import { crosslink } from './crosslink.mjs';
import { computePositions, packLayout, layoutInputHash } from './layout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PARAMS = {
  nodeTarget: 30_000,
  maxDepth: 5,
  crosslinkMinArticleCount: 10,
  crosslinkMinShared: 3,
  crosslinkTopK: 20,
  crosslinkGlobalCap: 400_000,
  crosslinkMemberSample: 200,
  metaFilterPatterns: MAINTENANCE_PATTERNS,
};

const VERSION = '1';

/**
 * Run the five pruning passes over the SQLite graph and emit dense-indexed
 * nodes. Returns a map from SQLite cat.id to dense node index so cross-link
 * edges can be remapped into the same space.
 */
export function pruneToNodes(db, params) {
  const rows = db.prepare('SELECT id, name FROM cat ORDER BY name').all();
  const keptNames = new Set(applyMetaFilter(rows.map(r => r.name)));

  const dbIndex = new Map();
  const names = [];
  rows.forEach(r => {
    if (!keptNames.has(r.name)) return;
    dbIndex.set(r.id, dbIndex.size);
    names.push(r.name);
  });
  const nodeCount = dbIndex.size;
  const afterMetaFilter = nodeCount;

  const parentsByChild = Array.from({ length: nodeCount }, () => []);
  for (const e of db.prepare('SELECT child, parent FROM parent').all()) {
    const child = dbIndex.get(e.child);
    const parent = dbIndex.get(e.parent);
    if (child === undefined || parent === undefined) continue;
    parentsByChild[child].push(parent);
  }

  // cat_pages is MediaWiki's authoritative article count (see Task 3). Counting
  // member rows undercounts badly because member only holds meta-filtered rows.
  const articleCount = new Int32Array(nodeCount);
  for (const r of db.prepare('SELECT id, cat_pages FROM cat').all()) {
    const i = dbIndex.get(r.id);
    if (i !== undefined) articleCount[i] = r.cat_pages;
  }

  // Pass 2
  const { primary, demoted } = selectPrimaryParents(parentsByChild, nodeCount);
  const parentOf = breakCycles(primary, demoted, nodeCount);

  // Pass 3
  const capped = capDepth(parentOf, nodeCount, params.maxDepth);

  // Passes 4 and 5
  const depthBeforeCut = assignDepth(capped.parentOf, nodeCount);
  const { kept, restoredCount } = rankAndCut(
    capped.parentOf, depthBeforeCut, articleCount, nodeCount, params.nodeTarget,
  );

  const remap = new Int32Array(nodeCount).fill(-1);
  const sqliteToDense = new Map();
  const order = [];
  for (let i = 0; i < nodeCount; i++) {
    if (!kept[i]) continue;
    remap[i] = order.length;
    sqliteToDense.set(i, order.length);
    order.push(i);
  }

  // `aliases` is intentionally always empty in v1. Redirect-derived alternates
  // need enwiki-latest-redirect.sql.gz, which is not part of the input data.
  // An empty array means "not computed yet" and consumers must not read it as
  // "this concept has no alternates".
  const nodes = order.map(i => ({
    id: slugify(names[i]),
    name: names[i],
    parent: capped.parentOf[i] === -1 ? -1 : (remap[capped.parentOf[i]] ?? -1),
    depth: depthBeforeCut[i],
    articleCount: articleCount[i],
    aliases: [],
  }));

  assertAcyclic(Int32Array.from(nodes.map(n => n.parent)), nodes.length);

  return {
    nodes,
    sqliteToDense,
    counts: {
      rawCategories: rows.length,
      afterMetaFilter,
      afterDepthCap: capped.removedCount,
      finalNodes: nodes.length,
      restoredAncestors: restoredCount,
    },
  };
}

export async function buildAll({
  outDir,
  dbPath,
  buildDb,
  params = DEFAULT_PARAMS,
  version = VERSION,
  generatedAt = new Date().toISOString(),
} = {}) {
  const finalParams = { ...DEFAULT_PARAMS, ...params };
  mkdirSync(outDir, { recursive: true });

  if (buildDb) await buildDb();
  else if (!existsSync(dbPath)) {
    throw new Error(
      `No database at ${dbPath}. Place enwiki-latest-page.sql.gz and ` +
      'enwiki-latest-categorylinks.sql.gz in the repo root, then run: npm run ingest',
    );
  }

  const db = new Database(dbPath, { readonly: true });
  const { nodes, sqliteToDense, counts } = pruneToNodes(db, finalParams);
  db.close();

  // Cross-links are computed in SQLite cat.id space; remap into dense space.
  // Edges whose endpoint was pruned are dropped here, at build time, and
  // counted. They must never reach the artifact for a user to click.
  const edges = [];
  const seen = new Set();
  let dangling = 0;
  for (const e of crosslink(dbPath, finalParams)) {
    const a = sqliteToDense.get(e.a);
    const b = sqliteToDense.get(e.b);
    if (a === undefined || b === undefined || a === b) { dangling++; continue; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}:${hi}`;
    if (seen.has(key)) { dangling++; continue; }
    seen.add(key);
    edges.push({ a: lo, b: hi, shared: e.shared });
  }
  edges.sort((x, y) => (x.a - y.a) || (x.b - y.b));
  if (dangling) console.warn(`  ${dangling} cross-link edge(s) dropped: endpoint was pruned`);

  const concepts = buildConceptsFile(nodes, null, version);
  const crosslinks = buildCrosslinksFile(edges);

  // Skip the ~25s force layout when the node set is byte-identical to last run.
  const hash = layoutInputHash(nodes);
  const hashPath = resolve(outDir, 'layout.hash');
  const binPath = resolve(outDir, 'layout.bin');
  let layoutBuffer;
  if (existsSync(hashPath) && existsSync(binPath)
      && readFileSync(hashPath, 'utf8').trim() === hash) {
    const cached = readFileSync(binPath);
    layoutBuffer = cached.buffer.slice(
      cached.byteOffset, cached.byteOffset + cached.byteLength,
    ) as ArrayBuffer;
    console.log('  layout.bin unchanged, reusing cached positions');
  } else {
    layoutBuffer = packLayout(computePositions(nodes), edges);
    writeFileSync(hashPath, hash);
  }

  const meta = buildMeta(
    { ...counts, crosslinks: edges.length, danglingCrosslinks: dangling },
    finalParams, null, version, generatedAt,
  );

  const files = {};
  const write = (name, data) => { writeFileSync(resolve(outDir, name), data); files[name] = true; };
  write('concepts.json', JSON.stringify(concepts));
  write('crosslinks.json', JSON.stringify(crosslinks));
  write('layout.bin', Buffer.from(layoutBuffer));
  write('meta.json', JSON.stringify(meta, null, 2));

  return { files, concepts, crosslinks, layoutBuffer, meta, nodes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAll({ outDir: resolve(ROOT, 'src/data/artifacts'), dbPath: resolve(ROOT, 'atlas-work/atlas.db') })
    .then(({ meta, files }) => {
      console.log('artifacts written');
      console.table(meta.counts);
      console.log('files:', Object.keys(files).join(', '));
    })
    .catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run scripts/lib/__tests__/pipeline.test.mjs`
Expected: PASS, 8 tests. **If the cross-link assertion fails, the SQLite-to-dense remap is wrong** — that is the single most likely defect in this task.

- [ ] **Step 5: Run every unit test**

Run: `npx vitest run`
Expected: PASS — 65 tests across 9 files.

- [ ] **Step 6: Commit**

```bash
git add scripts
git commit -m "feat(scripts): artifact build orchestrator with injectable database"
```

- [ ] **Step 7: Run the real pipeline against the 4.6 GB dumps**

```bash
ls -lh ../enwiki-latest-page.sql.gz ../enwiki-latest-categorylinks.sql.gz ../enwiki-latest-category.sql.gz
time npm run ingest
time npm run build:artifacts
```

Expect `ingest` to report non-zero counts and `build:artifacts` to write four files into `src/data/artifacts/`.

**If the dumps are absent, stop and report the blocker.** Tasks 10–16 need real artifacts, and fabricating placeholder data would let the whole frontend be "verified" against fiction.

- [ ] **Step 8: Inspect the real output before building on it**

```bash
ls -lh src/data/artifacts/
node -e "
const c = require('./src/data/artifacts/concepts.json');
const m = require('./src/data/artifacts/meta.json');
console.log('nodes', c.nodeCount, 'maxDepth', Math.max(...c.nodes.map(n => n.depth)));
console.log('roots', c.nodes.filter(n => n.parent === -1).length);
console.log(JSON.stringify(m.counts));
console.log('top by articles:');
console.log(c.nodes.slice().sort((a,b)=>b.articleCount-a.articleCount).slice(0,10).map(n=>n.name+' ('+n.articleCount+')').join('\n'));
console.log('root names:');
console.log(c.nodes.filter(n=>n.parent===-1).slice(0,40).map(n=>n.name).join(', '));
"
```

Expected: 30,000 nodes, max depth <= 5, and a plausible set of roots — not `Main topic`, `Articles`, or `Wikipedia categories`.

**If the roots are garbage, the meta filter needs another pattern. Fix it here, before a frontend is built on top of it.** Every later task inherits whatever shape this step produces.

- [ ] **Step 9: Commit the artifacts**

```bash
git add src/data/artifacts
git commit -m "chore: generate knowledge atlas artifacts from enwiki dumps"
```

---

## Task 10: Tree traversal utilities

**Files:**
- Create: `src/lib/artifacts/graph.ts`
- Test: `src/lib/artifacts/__tests__/graph.test.ts`

**Interfaces:**
- Consumes: `ConceptsFile`, `CrossLink` from Task 2.
- Produces:
  ```ts
  export interface AtlasIndex {
    nodes: Concept[];
    childrenOf: number[][];   // by node index
    parentsOf: number[][];    // primary parents, by node index
    crosslinksOf: number[][]; // neighbour indices, deduped
    byId: Map<string, number>;
    byName: Map<string, number>;
  }
  export function buildIndex(file: ConceptsFile, crosslinks?: CrossLink[]): AtlasIndex;
  export function ancestorsOf(index: AtlasIndex, i: number): number[];   // root-first, excludes i
  export function pathToRoot(index: AtlasIndex, i: number): number[];    // root-first, includes i
  export function descendantsOf(index: AtlasIndex, i: number): number[];
  export function subtreeSize(index: AtlasIndex, i: number): number;
  export function neighboursOf(index: AtlasIndex, i: number): number[];
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/artifacts/__tests__/graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildIndex, ancestorsOf, descendantsOf, subtreeSize, pathToRoot }
  from '../graph';
import type { ConceptsFile } from '../types';

const file: ConceptsFile = {
  version: '1', dumpDate: null, nodeCount: 5,
  nodes: [
    { id: 'root', name: 'Natural sciences', parent: -1, depth: 0, articleCount: 1000, aliases: [] },
    { id: 'physics', name: 'Physics', parent: 0, depth: 1, articleCount: 500, aliases: [] },
    { id: 'chem', name: 'Chemistry', parent: 0, depth: 1, articleCount: 300, aliases: [] },
    { id: 'thermo', name: 'Thermodynamics', parent: 1, depth: 2, articleCount: 80, aliases: [] },
    { id: 'entropy', name: 'Entropy', parent: 3, depth: 3, articleCount: 20, aliases: [] },
  ],
};

const index = buildIndex(file);

describe('buildIndex', () => {
  it('maps ids and names to indices', () => {
    expect(index.byId.get('thermo')).toBe(3);
    expect(index.byName.get('Entropy')).toBe(4);
  });
  it('groups children by parent', () => {
    expect(index.childrenOf[0]).toEqual([1, 2]);
  });
  it('indexes crosslinks in both directions', () => {
    const linked = buildIndex(file, [{ a: 1, b: 4, shared: 9 }]);
    expect(linked.crosslinksOf[1]).toEqual([4]);
    expect(linked.crosslinksOf[4]).toEqual([1]);
  });
  it('has empty crosslink lists when none are supplied', () => {
    expect(index.crosslinksOf[0]).toEqual([]);
  });
});

describe('ancestorsOf', () => {
  it('returns ancestors root-first, excluding the node itself', () => {
    expect(ancestorsOf(index, 4)).toEqual([0, 1, 3]);
  });
  it('returns an empty array for a root', () => {
    expect(ancestorsOf(index, 0)).toEqual([]);
  });
});

describe('pathToRoot', () => {
  it('includes the node itself, root-first', () => {
    expect(pathToRoot(index, 4)).toEqual([0, 1, 3, 4]);
  });
});

describe('descendantsOf', () => {
  it('returns every node beneath the given one', () => {
    expect(descendantsOf(index, 1).sort((a, b) => a - b)).toEqual([3, 4]);
  });
  it('returns an empty array for a leaf', () => {
    expect(descendantsOf(index, 4)).toEqual([]);
  });
});

describe('subtreeSize', () => {
  it('counts the node and all its descendants', () => {
    expect(subtreeSize(index, 1)).toBe(3);
  });
  it('counts a leaf as 1', () => {
    expect(subtreeSize(index, 4)).toBe(1);
  });
});

describe('traversal safety', () => {
  it('returns an empty array for an out-of-range index rather than throwing', () => {
    expect(ancestorsOf(index, 999)).toEqual([]);
    expect(descendantsOf(index, -1)).toEqual([]);
    expect(subtreeSize(index, 999)).toBe(1);
  });
  it('terminates on a self-referential parent instead of hanging', () => {
    const cyclic: ConceptsFile = {
      version: '1', dumpDate: null, nodeCount: 2,
      nodes: [
        { id: 'a', name: 'A', parent: 1, depth: 0, articleCount: 1, aliases: [] },
        { id: 'b', name: 'B', parent: 0, depth: 1, articleCount: 1, aliases: [] },
      ],
    };
    expect(() => pathToRoot(buildIndex(cyclic), 0)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run src/lib/artifacts/__tests__/graph.test.ts`
Expected: FAIL — `Cannot find module '../graph'`.

- [ ] **Step 3: Implement the traversal utilities**

Create `src/lib/artifacts/graph.ts`:

```ts
import type { Concept, ConceptsFile, CrossLink } from './types';

export interface AtlasIndex {
  nodes: Concept[];
  childrenOf: number[][];
  parentsOf: number[][];
  crosslinksOf: number[][];
  byId: Map<string, number>;
  byName: Map<string, number>;
}

export function buildIndex(file: ConceptsFile, crosslinks: CrossLink[] = []): AtlasIndex {
  const nodes = file.nodes;
  const n = nodes.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  const parentsOf: number[][] = Array.from({ length: n }, () => []);
  const crosslinksOf: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const p = nodes[i].parent;
    if (p >= 0 && p < n && p !== i) {
      childrenOf[p].push(i);
      parentsOf[i].push(p);
    }
  }

  for (const e of crosslinks) {
    if (e.a < 0 || e.b < 0 || e.a >= n || e.b >= n || e.a === e.b) continue;
    crosslinksOf[e.a].push(e.b);
    crosslinksOf[e.b].push(e.a);
  }

  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  nodes.forEach((c, i) => {
    byId.set(c.id, i);
    byName.set(c.name, i);
  });

  return { nodes, childrenOf, parentsOf, crosslinksOf, byId, byName };
}

export function pathToRoot(index: AtlasIndex, i: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let node = i;
  while (node >= 0 && node < index.nodes.length && !seen.has(node)) {
    seen.add(node);
    out.push(node);
    node = index.nodes[node].parent;
  }
  return out.reverse();
}

export function ancestorsOf(index: AtlasIndex, i: number): number[] {
  return pathToRoot(index, i).slice(0, -1);
}

export function descendantsOf(index: AtlasIndex, i: number): number[] {
  if (i < 0 || i >= index.nodes.length) return [];
  const out: number[] = [];
  const seen = new Set<number>([i]);
  const stack = [...index.childrenOf[i]];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    out.push(node);
    for (const child of index.childrenOf[node]) stack.push(child);
  }
  return out;
}

export function subtreeSize(index: AtlasIndex, i: number): number {
  return 1 + descendantsOf(index, i).length;
}

export function neighboursOf(index: AtlasIndex, i: number): number[] {
  return [...new Set(index.crosslinksOf[i])];
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run src/lib/artifacts/__tests__/graph.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/artifacts
git commit -m "feat(lib): tree traversal and index utilities"
```

---

## Task 11: Search

**Files:**
- Create: `src/components/search/search.ts`, `SearchBox.svelte`
- Test: `src/components/search/__tests__/search.test.ts`

**Interfaces:**
- Consumes: `AtlasIndex` from Task 10.
- Produces:
  ```ts
  export interface SearchHit { index: number; name: string; score: number; matchedAlias: boolean; }
  export function search(index: AtlasIndex, query: string, limit?: number): SearchHit[];
  ```

- [ ] **Step 1: Write the failing search test**

Create `src/components/search/__tests__/search.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { search } from '../search';
import { buildIndex } from '../../../lib/artifacts/graph';
import type { ConceptsFile } from '../../../lib/artifacts/types';

const file: ConceptsFile = {
  version: '1', dumpDate: null, nodeCount: 4,
  nodes: [
    { id: 'physics', name: 'Physics', parent: -1, depth: 0, articleCount: 500, aliases: [] },
    { id: 'astro', name: 'Astrophysics', parent: -1, depth: 0, articleCount: 90, aliases: [] },
    { id: 'quantum', name: 'Quantum mechanics', parent: -1, depth: 1, articleCount: 70, aliases: ['QM'] },
    { id: 'bio', name: 'Molecular biology', parent: -1, depth: 1, articleCount: 60, aliases: ['mol bio'] },
  ],
};
const index = buildIndex(file);

describe('search', () => {
  it('returns nothing for an empty query', () => {
    expect(search(index, '')).toEqual([]);
  });
  it('is case insensitive', () => {
    expect(search(index, 'PHYSICS')[0].name).toBe('Physics');
  });
  it('ranks an exact name match above a prefix match', () => {
    const hits = search(index, 'physics');
    expect(hits[0].name).toBe('Physics');
    expect(hits[1].name).toBe('Astrophysics');
  });
  it('finds matches in the middle of a name', () => {
    expect(search(index, 'molecular')[0].name).toBe('Molecular biology');
  });
  it('finds alias matches and flags them', () => {
    const [hit] = search(index, 'qm');
    expect(hit.name).toBe('Quantum mechanics');
    expect(hit.matchedAlias).toBe(true);
  });
  it('respects the limit', () => {
    expect(search(index, 'o', 2)).toHaveLength(2);
  });
  it('returns an empty array when nothing matches', () => {
    expect(search(index, 'zzzznotathing')).toEqual([]);
  });
  it('ignores surrounding whitespace', () => {
    expect(search(index, '  physics  ')[0].name).toBe('Physics');
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run src/components/search/__tests__/search.test.ts`
Expected: FAIL — `Cannot find module '../search'`.

- [ ] **Step 3: Implement the scan**

Create `src/components/search/search.ts`:

```ts
import type { AtlasIndex } from '../../lib/artifacts/graph';

export interface SearchHit {
  index: number;
  name: string;
  score: number;
  matchedAlias: boolean;
}

const EXACT = 1000;
const PREFIX = 500;
const SUBSTRING = 250;
const ALIAS_EXACT = 400;
const ALIAS_PREFIX = 350;
const ALIAS_SUBSTRING = 250;

export function search(index: AtlasIndex, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];
  const nodes = index.nodes;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const name = node.name.toLowerCase();
    let score = 0;
    let matchedAlias = false;

    if (name === q) score = EXACT;
    else if (name.startsWith(q)) score = PREFIX - Math.min(name.length - q.length, 100);
    else if (name.includes(q)) score = SUBSTRING - Math.min(name.length, 100);

    if (score === 0) {
      for (const alias of node.aliases) {
        const a = alias.toLowerCase();
        if (a === q) { score = ALIAS_EXACT; matchedAlias = true; break; }
        if (a.startsWith(q)) { score = ALIAS_PREFIX; matchedAlias = true; break; }
        if (a.includes(q)) { score = ALIAS_SUBSTRING; matchedAlias = true; break; }
      }
    }

    if (score > 0) {
      // Break ties toward substantive fields, capped so it can never outrank a
      // better textual match.
      score += Math.min(node.articleCount / 10_000, 50);
      hits.push({ index: i, name: node.name, score, matchedAlias });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run src/components/search/__tests__/search.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Build the SearchBox component**

Create `src/components/search/SearchBox.svelte`:

```svelte
<script lang="ts">
  import { search, type SearchHit } from './search';
  import type { AtlasIndex } from '../../lib/artifacts/graph';

  interface Props {
    index: AtlasIndex;
    onNavigate: (index: number) => void;
    placeholder?: string;
  }
  const { index, onNavigate, placeholder = 'Search fields' }: Props = $props();

  let query = $state('');
  let hits = $state<SearchHit[]>([]);
  let open = $state(false);

  function run() { hits = search(index, query, 20); }
  function clear() { query = ''; hits = []; }
  function choose(hit: SearchHit) { clear(); onNavigate(hit.index); }
</script>

<div class="searchbox" role="search">
  <input
    type="search"
    {placeholder}
    bind:value={query}
    oninput={run}
    onfocus={() => (open = true)}
    onblur={() => setTimeout(() => (open = false), 120)}
  />
  {#if query && open && hits.length}
    <ul class="results">
      {#each hits as hit (hit.index)}
        <li>
          <button type="button" onmousedown={() => choose(hit)}>
            <span class="name">{hit.name}</span>
            {#if hit.matchedAlias}<span class="alias">alias</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .searchbox { position: relative; }
  input {
    width: 100%;
    padding: 0.7rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.9rem;
  }
  input:focus { outline: none; border-color: var(--accent); }
  .results {
    position: absolute; top: calc(100% + 0.25rem); left: 0; right: 0; z-index: 20;
    margin: 0; padding: 0.25rem; list-style: none;
    background: var(--bg-tertiary);
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    max-height: 20rem; overflow-y: auto;
  }
  button {
    display: flex; width: 100%; align-items: center; gap: 0.5rem;
    padding: 0.45rem 0.6rem; background: none; border: none;
    color: var(--text-primary); font: inherit; font-size: 0.85rem;
    text-align: left; cursor: pointer; border-radius: 0.25rem;
  }
  button:hover { background: var(--accent-soft); }
  .alias {
    font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-muted); border: 1px solid var(--line); padding: 0 0.3rem;
  }
</style>
```

- [ ] **Step 6: Commit**

```bash
git add src/components/search
git commit -m "feat(search): zero-dependency scan and search box"
```

---

## Task 12: Layout, navigation, and the tree view

**Files:**
- Modify: `src/components/layout/BaseLayout.astro`, `src/components/layout/Footer.astro`
- Create: `src/components/layout/TopBar.astro`
- Create: `src/components/tree/CollapsibleTree.svelte`, `TreeNode.svelte`
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `buildIndex`, `AtlasIndex` (Task 10); `SearchBox` (Task 11).
- Produces: route `/` rendering the collapsible tree.

- [ ] **Step 1: Strip the branding from BaseLayout**

In `src/components/layout/BaseLayout.astro`:

Replace `<title>{title} — Arbor</title>` with `<title>{title}</title>`.

Replace the entire `<header>` element with:

```astro
    <header class="header">
      <slot name="nav" />
    </header>
```

Delete the `.brand`, `.brand-name`, `.brand-tagline`, `.nav`, `.nav-list`, and `.nav-link` rules. Keep `.header`, `.header-top`, `.theme-toggle`, `.main`, `.footer`, `.eyebrow`, `.page-title`, `.page-subtitle`, `.search-bar`, and the theme script.

In `src/components/layout/Footer.astro`, replace the branding text with:

```astro
  <p>Generated from English Wikipedia category structure.</p>
```

- [ ] **Step 2: Create the TopBar**

Create `src/components/layout/TopBar.astro`:

```astro
---
interface Props {
  current?: 'browse' | 'graph' | 'method';
}
const { current } = Astro.props;

const items = [
  { key: 'browse', label: 'Browse', href: '/' },
  { key: 'graph', label: 'Graph', href: '/graph' },
  { key: 'method', label: 'Method', href: '/method' },
];
---

<nav class="topbar">
  <ul>
    {items.map(item => (
      <li>
        <a href={item.href} class:list={{ active: current === item.key }}>{item.label}</a>
      </li>
    ))}
  </ul>
</nav>

<style>
  .topbar { display: flex; justify-content: center; }
  .topbar ul {
    display: flex; gap: 0.5rem; list-style: none; margin: 0; padding: 0;
  }
  .topbar a {
    display: block;
    padding: 0.5rem 1.25rem;
    border: 1px solid transparent;
    border-radius: 20px;
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--text-muted);
    text-decoration: none;
    transition: all 0.3s ease;
  }
  .topbar a:hover { color: var(--text-secondary); border-color: var(--line-light); }
  .topbar a.active { background: var(--accent); color: var(--bg-primary); font-weight: 500; }
</style>
```

- [ ] **Step 3: Build the collapsible tree**

Create `src/components/tree/CollapsibleTree.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { AtlasIndex } from '../../lib/artifacts/graph';

  interface Props {
    index: AtlasIndex;
    hasPage: (i: number) => boolean;
    onFocus?: (i: number) => void;
  }
  const { index, hasPage, onFocus }: Props = $props();

  let container: HTMLDivElement | null = $state(null);
  let svgSel: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  let zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  let root: d3.HierarchyNode<number> | null = null;
  let seq = 0;

  const DURATION = 400;
  const H_SPACING = 200;
  const V_SPACING = 46;

  interface Datum { index: number; }
  type TreeNode = d3.HierarchyPointNode<Datum>;

  onMount(() => { if (container) draw(); });
  onDestroy(() => { if (container) d3.select(container).selectAll('*').remove(); });

  function draw() {
    if (!container) return;
    d3.select(container).selectAll('*').remove();

    const width = container.clientWidth;
    const height = container.clientHeight;

    svgSel = d3.select(container)
      .append('svg')
      .attr('width', width).attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    const g = svgSel.append('g').attr('class', 'vis');

    zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .on('zoom', ev => g.attr('transform', ev.transform.toString()));
    svgSel.call(zoom);

    root = d3.hierarchy<number>(0, id => {
      const kids = index.childrenOf[id] ?? [];
      return kids.length ? kids : null;
    });

    // Start collapsed to the roots so the top-level shape is visible first.
    collapseAll(root);
    update(root);
  }

  function collapseAll(node: d3.HierarchyNode<number>) {
    if (node.children) {
      (node as any)._children = node.children;
      (node as any).children = null;
      node._children?.forEach(collapseAll);
    }
  }

  function toggle(d: TreeNode) {
    const node = d as any;
    if (node.children) {
      node._children = node.children;
      node.children = null;
    } else {
      node.children = node._children ?? null;
      node._children = null;
    }
    update(d);
  }

  function update(source: d3.HierarchyNode<number>) {
    if (!root || !svgSel) return;
    const tree = d3.tree<number>().nodeSize([V_SPACING, H_SPACING]);
    tree(root);

    const nodes = root.descendants().reverse();
    const links = root.links();
    const diagonal = d3.linkHorizontal<any, any>().x(d => d.y).y(d => d.x);
    const g = svgSel.select('.vis');

    const node = g.selectAll<SVGGElement, TreeNode>('g.node').data(nodes, d => (d as any).id ?? ((d as any).id = ++seq));

    const enter = node.enter().append('g')
      .attr('class', 'node')
      .attr('transform', `translate(${(source as any).y0 ?? 0},${(source as any).x0 ?? 0})`)
      .style('cursor', 'pointer')
      .on('click', (_ev, d) => {
        if ((index.childrenOf[d.data] ?? []).length) toggle(d);
        else onFocus?.(d.data);
      });

    enter.append('circle').attr('r', 1e-6);
    enter.append('text')
      .attr('dy', '0.35em')
      .attr('x', d => (index.childrenOf[d.data] ?? []).length ? 9 : 16)
      .attr('text-anchor', 'start');

    const merged = node.merge(enter).transition().duration(DURATION)
      .attr('transform', d => `translate(${d.y},${d.x})`);

    merged.select('circle')
      .attr('r', d => ((index.childrenOf[d.data] ?? []).length ? 5 : 3))
      .attr('fill', d => (d.depth === 0 ? 'var(--accent)' : 'none'))
      .attr('stroke', d => ((index.childrenOf[d.data] ?? []).length ? 'var(--line-light)' : 'var(--text-muted)'))
      .attr('stroke-width', 1.5);

    merged.select('text')
      .attr('fill', d => (hasPage(d.data) ? 'var(--text-primary)' : 'var(--text-muted)'))
      .attr('font-size', d => (d.depth === 0 ? '14px' : '13px'))
      .text(d => {
        const node = index.nodes[d.data];
        const kids = (index.childrenOf[d.data] ?? []).length;
        const count = kids > 0 ? `  (${kids})` : '';
        return `${node.name}${count}`;
      });

    node.exit().transition().duration(DURATION)
      .attr('transform', d => `translate(${(source as any).y},${(source as any).x})`)
      .remove();

    const link = g.selectAll<SVGPathElement, d3.HierarchyPointLink<number>>('path.link')
      .data(links, d => (d.target as any).id);

    link.enter().insert('path', 'g.node')
      .attr('class', 'link')
      .attr('d', () => {
        const o = source as any;
        return diagonal({ source: { x: o.x0 ?? 0, y: o.y0 ?? 0 }, target: { x: o.x0 ?? 0, y: o.y0 ?? 0 } });
      })
      .attr('fill', 'none')
      .attr('stroke', 'var(--line)')
      .attr('stroke-width', 1);

    link.merge(link.enter().selection() as any).transition().duration(DURATION)
      .attr('d', diagonal as any);

    link.exit().transition().duration(DURATION)
      .attr('d', () => {
        const o = source as any;
        return diagonal({ source: { x: o.x, y: o.y }, target: { x: o.x, y: o.y } });
      })
      .remove();

    nodes.forEach(d => { (d as any).x0 = d.x; (d as any).y0 = d.y; });
  }

  export function expandTo(i: number) {
    if (!root) return;
    const target = root.descendants().find(d => d.data === i);
    if (!target) return;
    (target.ancestors() as any[]).forEach(a => {
      if (a._children) { a.children = a._children; a._children = null; }
    });
    update(root);
  }
</script>

<div class="tree" bind:this={container}></div>

<style>
  .tree { width: 100%; height: 100%; }
  .node circle { transition: r 0.2s ease, stroke 0.2s ease; }
  .node:hover circle { stroke: var(--accent) !important; }
  .node:hover text { fill: var(--accent) !important; }
  .link { transition: stroke 0.2s ease; }
</style>
```

**Note on `export function expandTo`:** Svelte 5 component exports require the component to be imported as a component reference, not a string. If the `export` keyword causes a compile error under runes mode, remove it and drive expansion from the parent instead by re-rendering the tree with an `expandTo` prop.

- [ ] **Step 4: Rewrite the index page**

Replace `src/pages/index.astro`:

```astro
---
import BaseLayout from '../components/layout/BaseLayout.astro';
import TopBar from '../components/layout/TopBar.astro';
import CollapsibleTree from '../components/tree/CollapsibleTree.svelte';
import { loadConcepts, loadCrosslinks } from '../lib/artifacts/load';
import { buildIndex } from '../lib/artifacts/graph';

let concepts = null;
let index = null;
let loadError = null;

try {
  const [c, x] = await Promise.all([
    fetch(new URL('../data/artifacts/concepts.json', import.meta.url)).then(r => r.json()),
    fetch(new URL('../data/artifacts/crosslinks.json', import.meta.url)).then(r => r.json()),
  ]);
  concepts = loadConcepts(c);
  index = buildIndex(concepts, loadCrosslinks(x).edges);
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
}

// Only substantial fields get a detail page; see Global Constraints.
const PAGE_LIMIT = 5000;
const pageSlugs = new Set(
  (concepts?.nodes ?? [])
    .slice()
    .sort((a, b) => b.articleCount - a.articleCount)
    .slice(0, PAGE_LIMIT)
    .map(n => n.id),
);
const hasPage = (i) => pageSlugs.has(index.nodes[i].id);
---

<BaseLayout title="Browse" currentPage="browse">
  <TopBar slot="nav" current="browse" />

  <div class="page">
    <header class="head">
      <p class="eyebrow">Atlas</p>
      <h1 class="page-title">The shape of what is known</h1>
      <p class="page-subtitle">
        {concepts ? `${concepts.nodeCount.toLocaleString()} fields, arranged by how they nest.`
                   : 'No artifacts generated yet.'}
      </p>
    </header>

    {loadError ? (
      <p class="error">Could not load artifacts: {loadError}</p>
    ) : (
      <div class="canvas">
        <CollapsibleTree client:only="svelte" {index} {hasPage} />
      </div>
    )}
  </div>
</BaseLayout>

<style>
  .page { max-width: 1400px; margin: 0 auto; padding: 40px 40px 80px; }
  .head { margin-bottom: 32px; }
  .canvas { height: 640px; }
  .error { color: #ef4444; font-size: 0.9rem; }
  @media (max-width: 768px) {
    .page { padding: 24px 16px 60px; }
    .canvas { height: 480px; }
  }
</style>
```

- [ ] **Step 5: Verify the tree page renders real data**

```bash
npm run build 2>&1 | tail -20
```

Expected: a successful build. If it reports missing artifacts, Task 9 Step 8 found a problem — resolve that first.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout src/components/tree src/pages/index.astro
git commit -m "feat(ui): unbranded layout, top nav, and collapsible tree view"
```

---

## Task 13: Field page

**Files:**
- Create: `src/pages/domains/[slug].astro`
- Create: `src/components/field/FieldHeader.svelte`, `ChildList.svelte`, `CrossLinks.svelte`

**Interfaces:**
- Consumes: `buildIndex`, `ancestorsOf`, `subtreeSize` (Task 10).
- Produces: route `/domains/[slug]`.

- [ ] **Step 1: Build the field page with `getStaticPaths`**

Create `src/pages/domains/[slug].astro`:

```astro
---
import BaseLayout from '../../components/layout/BaseLayout.astro';
import TopBar from '../../components/layout/TopBar.astro';
import ChildList from '../../components/field/ChildList.svelte';
import CrossLinks from '../../components/field/CrossLinks.svelte';
import { loadConcepts, loadCrosslinks } from '../../lib/artifacts/load';
import { buildIndex, ancestorsOf, subtreeSize } from '../../lib/artifacts/graph';

const PAGE_LIMIT = 5000;

const raw = await Promise.all([
  fetch(new URL('../../data/artifacts/concepts.json', import.meta.url)).then(r => r.json()),
  fetch(new URL('../../data/artifacts/crosslinks.json', import.meta.url)).then(r => r.json()),
]);
const concepts = loadConcepts(raw[0]);
const crosslinks = loadCrosslinks(raw[1]);
const index = buildIndex(concepts, crosslinks.edges);

export async function getStaticPaths() {
  return index.nodes
    .map((node, i) => ({ node, i }))
    .sort((a, b) => b.node.articleCount - a.node.articleCount)
    .slice(0, PAGE_LIMIT)
    .map(({ node, i }) => ({ params: { slug: node.id }, props: { i } }));
}

const { i } = Astro.props;
const node = index.nodes[i];
const ancestors = ancestorsOf(index, i);
const children = (index.childrenOf[i] ?? [])
  .map(c => ({ c, node: index.nodes[c] }))
  .sort((a, b) => b.node.articleCount - a.node.articleCount);

const demotedParents = (index.parentsOf[i] ?? [])
  .filter(p => p !== node.parent)
  .map(p => ({ p, node: index.nodes[p] }));

const related = [...new Set(index.crosslinksOf[i] ?? [])]
  .map(r => ({ r, node: index.nodes[r] }))
  .sort((a, b) => b.node.articleCount - a.node.articleCount)
  .slice(0, 20);

const subSize = subtreeSize(index, i);
---

<BaseLayout title={node.name} currentPage="browse">
  <TopBar slot="nav" current="browse" />

  <article class="field">
    <nav class="crumbs">
      {ancestors.map(a => (
        <a href={`/domains/${index.nodes[a].id}`}>{index.nodes[a].name}</a>
      ))}
      <span class="here">{node.name}</span>
    </nav>

    <header>
      <h1>{node.name}</h1>
      <dl class="stats">
        <div><dt>Articles</dt><dd>{node.articleCount.toLocaleString()}</dd></div>
        <div><dt>Subfields below</dt><dd>{subSize - 1}</dd></div>
        <div><dt>Depth</dt><dd>{node.depth}</dd></div>
      </dl>
    </header>

    {children.length > 0 && (
      <section>
        <h2>Subfields</h2>
        <ChildList client:load {children} />
      </section>
    )}

    {demotedParents.length > 0 && (
      <section>
        <h2>Also appears under</h2>
        <p class="hint">
          This field sits under more than one parent. The hierarchy above shows the largest;
          these are the others.
        </p>
        <CrossLinks client:load items={demotedParents} />
      </section>
    )}

    {related.length > 0 && (
      <section>
        <h2>Related fields</h2>
        <p class="hint">Strongest overlap by shared articles, across the whole atlas.</p>
        <CrossLinks client:load items={related} />
      </section>
    )}

    {children.length === 0 && demotedParents.length === 0 && related.length === 0 && (
      <p class="hint">This field has no recorded subfields or cross-links.</p>
    )}
  </article>
</BaseLayout>

<style>
  .field { max-width: 900px; margin: 0 auto; padding: 40px 40px 80px; }
  .crumbs { display: flex; flex-wrap: wrap; gap: 0.4rem; font-size: 0.8rem; margin-bottom: 24px; }
  .crumbs a { color: var(--text-muted); text-decoration: none; }
  .crumbs a:hover { color: var(--accent); }
  .crumbs a::after { content: ' / '; color: var(--line-light); }
  .here { color: var(--text-secondary); }
  h1 { font-family: var(--font-display); font-size: clamp(2rem, 5vw, 3rem); margin: 0 0 20px; }
  .stats { display: flex; gap: 2.5rem; margin: 0 0 40px; }
  dt { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted); }
  dd { margin: 4px 0 0; font-size: 1.4rem; font-family: var(--font-display); }
  section { margin-bottom: 40px; }
  h2 {
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.15em;
    color: var(--text-secondary); border-bottom: 1px solid var(--line);
    padding-bottom: 8px; margin: 0 0 16px;
  }
  .hint { font-size: 0.85rem; color: var(--text-muted); margin: 0 0 16px; }
</style>
```

- [ ] **Step 2: Build ChildList**

Create `src/components/field/ChildList.svelte`:

```svelte
<script lang="ts">
  import type { Concept } from '../../lib/artifacts/types';
  interface Props { children: { c: number; node: Concept }[]; }
  const { children }: Props = $props();
</script>

<ul>
  {#each children as { c, node } (c)}
    <li>
      <a href={`/domains/${node.id}`}>{node.name}</a>
      <span class="count">{node.articleCount.toLocaleString()}</span>
    </li>
  {/each}
</ul>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 1rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line);
  }
  a { color: var(--text-primary); text-decoration: none; }
  a:hover { color: var(--accent); }
  .count { font-size: 0.75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 3: Build CrossLinks**

Create `src/components/field/CrossLinks.svelte`:

```svelte
<script lang="ts">
  import type { Concept } from '../../lib/artifacts/types';
  interface Props { items: { p: number; node: Concept }[] | { r: number; node: Concept }[]; }
  const { items }: Props = $props();
  const rows = $derived(
    items.map(it => ({ id: (it as any).node.id, name: (it as any).node.name,
                       count: (it as any).node.articleCount })),
  );
</script>

<ul>
  {#each rows as row (row.id)}
    <li>
      <a href={`/domains/${row.id}`}>{row.name}</a>
      <span class="count">{row.count.toLocaleString()}</span>
    </li>
  {/each}
</ul>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
  li {
    display: flex; align-items: baseline; gap: 0.5rem;
    border: 1px solid var(--line); border-radius: 20px;
    padding: 0.35rem 0.85rem;
  }
  a { color: var(--text-primary); text-decoration: none; font-size: 0.85rem; }
  a:hover { color: var(--accent); }
  .count { font-size: 0.7rem; color: var(--text-muted); }
</style>
```

- [ ] **Step 4: Verify the page generates**

```bash
npm run build 2>&1 | tail -20
ls dist/domains | wc -l
```

Expected: build succeeds and `ls dist/domains | wc -l` prints 5000.

- [ ] **Step 5: Commit**

```bash
git add src/pages/domains src/components/field
git commit -m "feat(pages): field page with subfields, demoted parents and cross-links"
```

---

## Task 14: Method page

**Files:**
- Create: `src/pages/method.astro`

**Interfaces:**
- Consumes: `loadMeta` from Task 2.
- Produces: route `/method`.

- [ ] **Step 1: Build the method page**

Create `src/pages/method.astro`:

```astro
---
import BaseLayout from '../components/layout/BaseLayout.astro';
import TopBar from '../components/layout/TopBar.astro';
import { loadMeta } from '../lib/artifacts/load';

const meta = loadMeta(
  await fetch(new URL('../data/artifacts/meta.json', import.meta.url)).then(r => r.json()),
);

const stages = [
  ['Raw categories', 'Every namespace-14 category in the dump, before any filtering.'],
  ['After meta filter', 'Maintenance and meta categories removed by the patterns listed below.'],
  ['Depth cap', 'Nodes deeper than the depth cap, re-parented and dropped.'],
  ['Final nodes', 'Kept after ranking by article count, plus restored ancestors.'],
];

const steps = [
  ['Stream the dumps', 'Both SQL dumps are read row by row; neither is loaded whole. Category-to-category edges come from pages that are themselves categories.'],
  ['Filter', 'Maintenance categories are dropped by name pattern.'],
  ['Choose one parent', 'The category graph is a DAG. Each node keeps the parent with the largest subtree; every other parent becomes a cross-link. Cycles are broken by detaching the lowest-indexed member.'],
  ['Cap depth', 'Anything deeper than the depth cap is re-parented to the ancestor at that depth.'],
  ['Rank and cut', 'Nodes are ranked by article count and truncated to the target, then ancestors are restored so the tree stays connected.'],
  ['Cross-link', 'Categories sharing at least the threshold number of articles become weighted edges, truncated to the top degree per node.'],
  ['Lay out', 'A force layout runs once, offline. The browser only renders the stored coordinates.'],
];
---

<BaseLayout title="Method" currentPage="method">
  <TopBar slot="nav" current="method" />

  <article class="method">
    <p class="eyebrow">Method</p>
    <h1 class="page-title">How this was built</h1>

    <section>
      <h2>The pipeline</h2>
      <ol>
        {steps.map(([title, body]) => <li><strong>{title}.</strong> {body}</li>)}
      </ol>
    </section>

    <section>
      <h2>What survived</h2>
      <table>
        <tbody>
          {stages.map(([label, note]) => (
            <tr>
              <th>{label}</th>
              <td>{(meta.counts as any)[Object.keys(meta.counts).find(k => k.startsWith(
                label.split(' ')[0].toLowerCase())) ?? '']?.toLocaleString() ?? '—'}</td>
              <td class="note">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Parameters</h2>
      <dl class="params">
        <div><dt>Node target</dt><dd>{meta.params.nodeTarget.toLocaleString()}</dd></div>
        <div><dt>Max depth</dt><dd>{meta.params.maxDepth}</dd></div>
        <div><dt>Cross-link minimum articles</dt><dd>{meta.params.crosslinkMinArticleCount}</dd></div>
        <div><dt>Cross-link shared-article threshold</dt><dd>{meta.params.crosslinkMinShared}</dd></div>
        <div><dt>Cross-links per field</dt><dd>{meta.params.crosslinkTopK}</dd></div>
        <div><dt>Cross-link global cap</dt><dd>{meta.params.crosslinkGlobalCap.toLocaleString()}</dd></div>
        <div><dt>Articles sampled per field</dt><dd>{meta.params.crosslinkMemberSample}</dd></div>
        <div><dt>Cross-links emitted</dt><dd>{meta.counts.crosslinks.toLocaleString()}</dd></div>
      </dl>
    </section>

    <section>
      <h2>Names filtered out</h2>
      <p class="note">
        A category is dropped when its name matches any of these. This is a heuristic list,
        shown verbatim so it can be argued with.
      </p>
      <ul class="patterns">
        {meta.params.metaFilterPatterns.map(p => <li><code>{p}</code></li>)}
      </ul>
    </section>

    <section>
      <h2>Sources</h2>
      <ul>
        {meta.sources.map(s => (
          <li>
            <a href={s.url}>{s.name}</a>
            <span class="lic">{s.license}</span>
          </li>
        ))}
      </ul>
      <p class="note">Generated {meta.generatedAt}.</p>
    </section>
  </article>
</BaseLayout>

<style>
  .method { max-width: 760px; margin: 0 auto; padding: 40px 40px 80px; }
  section { margin-bottom: 44px; }
  h2 {
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.15em;
    color: var(--text-secondary); border-bottom: 1px solid var(--line);
    padding-bottom: 8px; margin: 0 0 16px;
  }
  ol { padding-left: 1.2rem; line-height: 1.7; font-size: 0.92rem; color: var(--text-secondary); }
  ol li { margin-bottom: 0.7rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { text-align: left; font-weight: 500; color: var(--text-primary); padding: 0.5rem 1rem 0.5rem 0; }
  td { padding: 0.5rem 1rem 0.5rem 0; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .note { color: var(--text-muted); font-size: 0.82rem; }
  .params { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.2rem; }
  .params dt { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); }
  .params dd { margin: 4px 0 0; font-size: 1.2rem; font-family: var(--font-display); }
  .patterns { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .patterns code { font-size: 0.75rem; color: var(--accent); background: var(--bg-tertiary); padding: 0.2rem 0.45rem; border-radius: 4px; }
  ul a { color: var(--text-primary); }
  .lic { color: var(--text-muted); font-size: 0.75rem; margin-left: 0.6rem; }
</style>
```

**Simplify the counts table:** the dynamic key lookup in `stages` is fragile and will render `—` for every row. Replace `stages` with an explicit array of `[label, key, note]` tuples and index `meta.counts[key]` directly:

```js
const stages = [
  ['Raw categories', 'rawCategories', 'Every namespace-14 category in the dump, before any filtering.'],
  ['After meta filter', 'afterMetaFilter', 'Maintenance and meta categories removed by the patterns listed below.'],
  ['Removed by depth cap', 'afterDepthCap', 'Nodes deeper than the cap, re-parented and dropped.'],
  ['Final nodes', 'finalNodes', 'Kept after ranking by article count.'],
  ['Restored ancestors', 'restoredAncestors', 'Pulled back in to keep the tree connected.'],
  ['Cross-links', 'crosslinks', 'Weighted edges from shared articles.'],
];
```

and the table body becomes:

```astro
{tr.stages.map(([label, key, note]) => (
  <tr>
    <th>{label}</th>
    <td>{(meta.counts as any)[key].toLocaleString()}</td>
    <td class="note">{note}</td>
  </tr>
))}
```

Apply this before moving on.

- [ ] **Step 2: Verify and commit**

```bash
npm run build 2>&1 | tail -10
git add src/pages/method.astro
git commit -m "feat(pages): method page rendering pipeline parameters and sources"
```

---

## Task 15: Graph view

**Files:**
- Create: `src/components/graph/atlas-controller.ts`, `Atlas.svelte`, `GraphPanel.svelte`
- Rewrite: `src/pages/graph.astro`

**Interfaces:**
- Consumes: `AtlasIndex` (Task 10), `parseLayout` (Task 2), `SearchBox` (Task 11).
- Produces: route `/graph`.

Search and the atlas must live in **one** Svelte island. Spec section 9 requires that typing a name flies the camera to that node. Two separate islands cannot share reactive state, and navigating away instead would abandon the graph — so `GraphPanel` owns both.

- [ ] **Step 1: Build the sigma controller**

Create `src/components/graph/atlas-controller.ts`:

```ts
import Graph from 'graphology';
import Sigma from 'sigma';
import type { AtlasIndex } from '../../lib/artifacts/graph';
import type { LayoutArrays } from '../../lib/artifacts/types';

export interface AtlasOptions {
  container: HTMLElement;
  index: AtlasIndex;
  layout: LayoutArrays;
  onSelect: (nodeIndex: number | null) => void;
}

export interface AtlasHandle {
  focus: (nodeIndex: number) => void;
  destroy: () => void;
}

const TRUNK_COLORS = ['#d4a574', '#2dd4bf', '#60a5fa', '#f87171', '#a78bfa', '#fbbf24', '#34d399', '#fb7185'];

/** Depth-0 nodes define the trunks; everything inherits its trunk's colour. */
function trunkOf(index: AtlasIndex, i: number): number {
  let node = i;
  let guard = 0;
  while (index.nodes[node].parent !== -1 && guard++ <= 10) node = index.nodes[node].parent;
  return node;
}

export function createAtlas({ container, index, layout, onSelect }: AtlasOptions): AtlasHandle {
  const graph = new Graph({ type: 'undirected', multi: false });
  const { nodes, crosslinksOf } = index;

  for (let i = 0; i < nodes.length; i++) {
    graph.addNode(String(i), {
      x: layout.x[i], y: layout.y[i],
      size: 2 + Math.min(Math.log10(nodes[i].articleCount + 1) * 1.6, 9),
      label: nodes[i].name,
      color: TRUNK_COLORS[trunkOf(index, i) % TRUNK_COLORS.length],
    });
  }

  for (let e = 0; e < layout.treeSrc.length; e++) {
    graph.addEdge(String(layout.treeSrc[e]), String(layout.treeDst[e]), { size: 0.3, color: '#2a2a2a' });
  }
  for (let e = 0; e < layout.crossSrc.length; e++) {
    const s = String(layout.crossSrc[e]);
    const t = String(layout.crossDst[e]);
    if (graph.hasEdge(s, t) || graph.hasEdge(t, s)) continue;
    graph.addEdge(s, t, { size: 0.8, color: '#d4a574' });
  }

  const renderer = new Sigma(graph, container, {
    renderEdgeLabels: false,
    labelDensity: 0.12,
    labelGridCellSize: 120,
    labelRenderedSizeThreshold: 9,
    defaultNodeColor: '#888',
    defaultEdgeColor: '#2a2a2a',
  });

  renderer.on('clickNode', ({ node }) => onSelect(Number(node)));
  renderer.on('clickStage', () => onSelect(null));

  return {
    focus(nodeIndex: number) {
      const n = graph.getNodeAttributes(String(nodeIndex));
      renderer.getCamera().animate({ x: n.x, y: n.y, ratio: 0.25 }, { duration: 400 });
    },
    destroy() { renderer.kill(); },
  };
}
```

`crosslinksOf` is destructured but unused — remove it from the destructure to avoid a lint error.

- [ ] **Step 2: Build the Atlas wrapper**

Create `src/components/graph/Atlas.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createAtlas, type AtlasHandle } from './atlas-controller';
  import type { AtlasIndex } from '../../lib/artifacts/graph';
  import type { LayoutArrays } from '../../lib/artifacts/types';

  interface Props {
    index: AtlasIndex;
    layout: LayoutArrays;
    focusIndex?: number | null;
    onSelect?: (i: number | null) => void;
  }
  const { index, layout, focusIndex = null, onSelect = () => {} }: Props = $props();

  let container: HTMLDivElement | null = $state(null);
  let handle: AtlasHandle | null = null;
  let error: string | null = null;

  onMount(() => {
    if (!container) return;
    try {
      handle = createAtlas({ container, index, layout, onSelect });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  });
  onDestroy(() => { handle?.destroy(); handle = null; });

  // React to search selection: fly the camera rather than navigating away.
  $effect(() => {
    if (focusIndex !== null && handle) handle.focus(focusIndex);
  });
</script>

{#if error}
  <div class="fallback">
    <p>The constellation could not be rendered: {error}</p>
    <p class="sub">Browsing still works — the tree and field pages do not depend on it.</p>
  </div>
{:else}
  <div class="canvas" bind:this={container}></div>
{/if}

<style>
  .canvas { width: 100%; height: 100%; }
  .fallback {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 0.5rem; color: var(--text-secondary); text-align: center; padding: 2rem;
  }
  .sub { color: var(--text-muted); font-size: 0.85rem; }
</style>
```

**This is the graceful degradation required by the spec.** A missing or corrupt `layout.bin` throws inside `createAtlas`, and the tree keeps working because it never reads that file.

- [ ] **Step 3: Build the GraphPanel island**

Search and the atlas must share reactive state — spec section 9 requires that typing a name flies the camera to that node, and navigating away would abandon the graph. So `GraphPanel` owns both. Splitting them into two islands cannot work.

Create `src/components/graph/GraphPanel.svelte`:

```svelte
<script lang="ts">
  import Atlas from './Atlas.svelte';
  import SearchBox from '../search/SearchBox.svelte';
  import type { AtlasIndex } from '../../lib/artifacts/graph';
  import type { LayoutArrays } from '../../lib/artifacts/types';

  interface Props {
    index: AtlasIndex;
    layout: LayoutArrays;
  }
  const { index, layout }: Props = $props();

  let focusIndex = $state<number | null>(null);
  let selected = $state<number | null>(null);

  const selectedNode = $derived(selected === null ? null : index.nodes[selected]);
  const neighbours = $derived(
    selected === null ? [] : [...new Set(index.crosslinksOf[selected])].slice(0, 8),
  );
</script>

<div class="panel">
  <div class="controls">
    <SearchBox
      {index}
      placeholder="Find a field"
      onNavigate={(i) => { focusIndex = i; selected = i; }}
    />

    <p class="legend">
      <span class="row"><span class="dot trunk"></span> trunk</span>
      <span class="row"><span class="dot tree-edge"></span> nesting</span>
      <span class="row"><span class="dot cross-edge"></span> shared articles</span>
    </p>

    {#if selectedNode}
      <div class="detail">
        <a href={`/domains/${selectedNode.id}`}>{selectedNode.name}</a>
        <span class="count">{selectedNode.articleCount.toLocaleString()} articles</span>
        {#if neighbours.length}
          <p class="related">Related</p>
          <ul>
            {#each neighbours as r (r)}
              <li>
                <button type="button" onclick={() => { focusIndex = r; selected = r; }}>
                  {index.nodes[r].name}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <p class="total">{index.nodes.length.toLocaleString()} fields</p>
  </div>

  <div class="canvas">
    <Atlas {index} {layout} {focusIndex} onSelect={(i) => (selected = i)} />
  </div>
</div>

<style>
  .panel { display: grid; grid-template-columns: 300px 1fr; gap: 20px; height: 680px; }
  .controls { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .legend { display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted); margin: 0; }
  .row { display: flex; align-items: center; }
  .dot { display: inline-block; margin-right: 0.5rem; }
  .dot.trunk { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
  .dot.tree-edge { width: 18px; height: 2px; background: #2a2a2a; }
  .dot.cross-edge { width: 18px; height: 2px; background: var(--accent); }
  .detail {
    border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.75rem;
    display: flex; flex-direction: column; gap: 0.35rem; overflow-y: auto;
  }
  .detail a { color: var(--text-primary); font-size: 0.95rem; text-decoration: none; }
  .detail a:hover { color: var(--accent); }
  .count { font-size: 0.72rem; color: var(--text-muted); }
  .related { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin: 0.5rem 0 0; }
  .detail ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .detail button {
    background: none; border: none; padding: 0; color: var(--text-secondary);
    font: inherit; font-size: 0.82rem; text-align: left; cursor: pointer;
  }
  .detail button:hover { color: var(--accent); }
  .total { font-size: 0.78rem; color: var(--text-muted); margin-top: auto; }
  .canvas {
    border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; background: var(--bg-secondary);
  }
  @media (max-width: 900px) {
    .panel { grid-template-columns: 1fr; height: auto; }
    .canvas { height: 480px; }
  }
</style>
```

- [ ] **Step 4: Rewrite the graph page**

Replace `src/pages/graph.astro`:

```astro
---
import BaseLayout from '../components/layout/BaseLayout.astro';
import TopBar from '../components/layout/TopBar.astro';
import GraphPanel from '../components/graph/GraphPanel.svelte';
import { loadConcepts, loadCrosslinks, parseLayout } from '../lib/artifacts/load';
import { buildIndex } from '../lib/artifacts/graph';

const concepts = loadConcepts(
  await fetch(new URL('../data/artifacts/concepts.json', import.meta.url)).then(r => r.json()),
);
const crosslinks = loadCrosslinks(
  await fetch(new URL('../data/artifacts/crosslinks.json', import.meta.url)).then(r => r.json()),
);
const index = buildIndex(concepts, crosslinks.edges);

const layout = parseLayout(
  await fetch(new URL('../data/artifacts/layout.bin', import.meta.url)).then(r => r.arrayBuffer()),
  concepts.nodeCount,
  concepts.nodes.filter(n => n.parent === -1).length,
  crosslinks.edges.length,
);
---

<BaseLayout title="Graph" currentPage="graph">
  <TopBar slot="nav" current="graph" />

  <div class="page">
    <header class="head">
      <p class="eyebrow">Constellation</p>
      <h1 class="page-title">Every field, in one space</h1>
    </header>

    <GraphPanel client:only="svelte" {index} {layout} />
  </div>
</BaseLayout>

<style>
  .page { max-width: 1500px; margin: 0 auto; padding: 40px 40px 60px; }
  .head { margin-bottom: 28px; }
</style>
```

- [ ] **Step 5: Verify and commit**

```bash
npm run build 2>&1 | tail -10
git add src/components/graph src/pages/graph.astro
git commit -m "feat(graph): sigma.js webgl constellation with search-to-focus and degradation"
```

---

## Task 16: Contract tests, smoke tests, and CI deploy

**Files:**
- Create: `src/lib/artifacts/__tests__/contract.test.ts`
- Create: `tests/e2e/smoke.spec.ts`
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: every artifact and route from Tasks 2–15.
- Produces: CI that builds and deploys to GitHub Pages.

- [ ] **Step 1: Write the contract test**

Create `src/lib/artifacts/__tests__/contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConcepts, loadCrosslinks, loadMeta, parseLayout } from '../load';

const DIR = resolve(process.cwd(), 'src/data/artifacts');
const present = existsSync(resolve(DIR, 'concepts.json'));

describe.skipIf(!present)('artifact contract', () => {
  const concepts = loadConcepts(JSON.parse(readFileSync(resolve(DIR, 'concepts.json'), 'utf8')));
  const crosslinks = loadCrosslinks(JSON.parse(readFileSync(resolve(DIR, 'crosslinks.json'), 'utf8')));
const meta = loadMeta(JSON.parse(readFileSync(resolve(DIR, 'meta.json'), 'utf8')));
const layoutBuf = readFileSync(resolve(DIR, 'layout.bin'));
// The tree is a forest: derive rootCount, never assume 1.
const rootCount = concepts.nodes.filter(n => n.parent === -1).length;
const layout = parseLayout(
  layoutBuf.buffer.slice(layoutBuf.byteOffset, layoutBuf.byteOffset + layoutBuf.byteLength) as ArrayBuffer,
  concepts.nodeCount,
  rootCount,
  crosslinks.edges.length,
);

  it('every tree edge endpoint exists', () => {
    for (let e = 0; e < layout.treeSrc.length; e++) {
      expect(layout.treeSrc[e]).toBeLessThan(concepts.nodeCount);
      expect(layout.treeDst[e]).toBeLessThan(concepts.nodeCount);
    }
  });

  it('every crosslink endpoint exists', () => {
    for (let e = 0; e < layout.crossSrc.length; e++) {
      expect(layout.crossSrc[e]).toBeLessThan(concepts.nodeCount);
      expect(layout.crossDst[e]).toBeLessThan(concepts.nodeCount);
      expect(layout.crossWeight[e]).toBeGreaterThan(0);
    }
  });

  it('crosslink edges carry positive weights and a < b', () => {
    for (const e of crosslinks.edges) {
      expect(e.a).toBeLessThan(e.b);
      expect(e.shared).toBeGreaterThanOrEqual(meta.params.crosslinkMinShared);
    }
  });

  it('every node is within the depth cap', () => {
    for (const n of concepts.nodes) expect(n.depth).toBeLessThanOrEqual(meta.params.maxDepth);
  });

  it('every non-root parent index is valid', () => {
    for (const n of concepts.nodes) {
      expect(n.parent).toBeGreaterThanOrEqual(-1);
      expect(n.parent).toBeLessThan(concepts.nodeCount);
    }
  });

  it('meta counts agree with the artifacts', () => {
    expect(meta.counts.finalNodes).toBe(concepts.nodeCount);
    expect(meta.counts.crosslinks).toBe(crosslinks.edges.length);
  });

  it('every node id is a non-empty unique slug', () => {
    const ids = new Set(concepts.nodes.map(n => n.id));
    expect(ids.size).toBe(concepts.nodeCount);
    for (const n of concepts.nodes) expect(n.id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/);
  });
});
```

- [ ] **Step 2: Run it against the real artifacts**

Run: `npx vitest run src/lib/artifacts/__tests__/contract.test.ts`
Expected: PASS, 7 tests. If any fail, the pipeline has a real defect — fix it in `scripts/`, regenerate, and re-run.

- [ ] **Step 3: Write the smoke test**

Create `tests/e2e/smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('browse renders the tree and expands a root', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('svg')).toBeVisible({ timeout: 15_000 });
  await page.locator('g.node').first().click();
  await expect(page.locator('g.node')).not.toHaveCount(1);
  expect(errors).toEqual([]);
});

test('search returns a result and navigates', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('input[type="search"]').first();
  await input.fill('physics');
  await expect(page.locator('.results li').first()).toBeVisible();
});

test('field page shows subfields', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  const input = page.locator('input[type="search"]').first();
  await input.fill('physics');
  await page.locator('.results button').first().click();
  await expect(page).toHaveURL(/\/domains\//);
  await expect(page.locator('h1')).toBeVisible();
  expect(errors).toEqual([]);
});

test('graph route mounts a canvas without throwing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/graph');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('method page renders pipeline parameters', async ({ page }) => {
  await page.goto('/method');
  await expect(page.locator('h1')).toContainText('built');
  await expect(page.locator('.params')).toBeVisible();
});

test('no page carries a product name in the navigation', async ({ page }) => {
  await page.goto('/');
  const nav = await page.locator('nav.topbar').innerText();
  expect(nav.toLowerCase()).not.toContain('arbor');
});
```

- [ ] **Step 4: Run the smoke tests**

```bash
npx playwright install chromium
npm run build && npx playwright test
```

Expected: PASS, 6 tests. The WebGL test may need `--use-gl=swiftshader` in CI; if it fails there, run Chromium with `channel: 'chromium'` and `--enable-unsafe-swiftshader`.

- [ ] **Step 5: Add the CI workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

CI does **not** run `ingest` or `build:artifacts`. Artifacts are committed. This is what keeps the deploy inside the 10-minute Pages limit.

- [ ] **Step 6: Verify the built site stays within the Pages size limit**

```bash
du -sh dist
find dist -size +90M
```

Expected: `dist` well under 1 GB. If a single file exceeds 90 MB, the concepts payload needs sharding before deploying.

- [ ] **Step 7: Commit**

```bash
git add src/lib/artifacts/__tests__/contract.test.ts tests .github
git commit -m "test: artifact contract, route smoke tests, and pages deploy workflow"
```

---

## Execution notes

**Order is load-bearing.** Tasks 1–9 are the offline pipeline; Tasks 10–16 are the frontend. Task 9 Step 8 is the gate: if the pruned roots look like garbage, everything downstream inherits that shape. Fix the meta filter before building views.

**One deliberate deviation from the spec.** Spec section 6 describes cross-link membership as a *second streaming pass* over `categorylinks.sql.gz`, because the `articleCount >= 10` threshold is not known until pass one finishes. This plan gets the same data from the SQLite `member` table that ingest already populated, rather than decompressing 2.4 GB a second time. Same result, one less full read of the file. The spec's intent — that eligibility depends on counts computed in ingest — is preserved; only the mechanism differs.

**Artifact regeneration.** When the dumps change:

```bash
npm run ingest && npm run build:artifacts
npm test && npm run build
git add src/data/artifacts && git commit -m "chore: regenerate artifacts"
```

`layout.hash` makes this skip the ~25s force recompute when the node set is unchanged. Delete `src/data/artifacts/layout.hash` and `layout.bin` to force it.

**The single most likely defect** in this plan is the SQLite `cat.id` to dense-node-index remap in Task 9 Step 3. The pipeline test asserts it directly; if the cross-link assertion fails there, that remap is wrong.