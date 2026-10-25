# Knowledge Atlas — Design Spec

**Date:** 2026-10-11
**Project:** `memex/` — an atlas of human knowledge domains
**Status:** Approved for implementation planning

---

## 1. Purpose

A browsable map of the shape of human knowledge: every field, subfield, category, and
subcategory, organized so that a person can see how the whole landscape fits together and
discover fields they did not know existed.

This is **not** an encyclopedia. It carries no prose, no definitions, no article text. Its
entire value is *structure*: what exists, how it nests, and how fields touch each other
across nominal boundaries.

**Deliberately excluded:** user accounts, progress tracking, learning paths, per-user state,
server-side database, any content authoring UI.

The site carries no name or wordmark. The header is a minimal navigation bar only.

---

## 2. Constraints

| Constraint | Value | Consequence |
|---|---|---|
| Host | GitHub Pages (free) | 1 GB published site; repo 1 GB recommended; **10 min deploy timeout** |
| Git | Blocks files >100 MiB, warns >50 MiB | Source dumps can never be committed |
| Input data | `enwiki-latest-page.sql.gz` (2.3 GB), `enwiki-latest-categorylinks.sql.gz` (2.4 GB) | 4.6 GB, processed locally, never in CI |
| CI budget | <10 min hard | Heavy ingest **cannot** run during deploy |
| Scale | ~30,000 concepts | SVG rendering is not viable |

Both dumps currently live untracked in the workspace root. A root `.gitignore` **must** be
added to exclude them; without it a `git add .` attempts a 4.6 GB commit.

---

## 3. Architecture

```
  LOCAL, ONE-OFF (~30 min)          REPO (committed)              CI (~2 min)
  ────────────────────────          ──────────────────              ──────────
  enwiki-*.sql.gz (4.6 GB)
        │
        ├─ ingest.mjs ──────┐
        ├─ prune.mjs  ──────┤
        ├─ crosslink.mjs ───┼──▶ src/data/artifacts/
        └─ layout.mjs  ────┘      concepts.json     ~6 MB
                                 crosslinks.json   ~4 MB
       (never committed)          layout.bin        ~0.7 MB
                                 meta.json         <1 KB
                                      │
                                      ▼
                              src/lib/artifacts/  ──▶  Astro build  ──▶  dist/
                              (only layer that                         (never
                               knows file formats)                      committed)
```

**The load-bearing decision:** all heavy work happens locally and its output is committed.
CI only renders. This is what keeps the deploy inside the 10-minute timeout — CI never
touches the 4.6 GB dumps, and never recomputes the force layout.

---

## 4. Data model

### 4.1 Concept

A single entity type covers the whole atlas. Rich per-field content is deliberately *not*
modelled; see §4.2.

```ts
interface Concept {
  id: string;          // URL-safe slug of the category name
  name: string;        // display name, e.g. "Thermodynamics"
  parent: number;      // index of primary parent, or -1 for a root
  depth: number;       // 0-5
  articleCount: number;// articles in this category in the dump — the significance signal
  aliases: string[];   // alternate names; empty in the first build, see §4.4
}
```

`parent` is an **index into the node array**, not an id string. This makes tree traversal
index-based and avoids 30,000 string comparisons per render.

### 4.2 Order of operations

The passes below are strictly ordered, because each depends on the previous:

```
meta filter  ──▶  primary parents  ──▶  depth cap  ──▶  rank & cut  ──▶  restore
  (no graph      (produces a forest,   (needs depth   (needs the       (needs the
   structure      so depth becomes      from the       full forest)    full forest)
   needed)        defined)
```

**Depth is only defined once primary parents exist.** On the raw DAG a node has as many
depths as it has parents, so depth cap cannot precede parent assignment. This ordering is
load-bearing and must not be rearranged.

### 4.3 Why there is no rich field type

An earlier schema (`src/utils/types.ts`) modelled every topic with a radial subtopic tree,
markdown prose, a roadmap, and a source list. Applying that to 30,000 nodes is not possible
and would not be useful — it is a description format, and this site carries no descriptions.

The schema is **removed**. `content-loader.ts` and `graph-builder.ts` are deleted. Nothing
in the current codebase reads them.

### 4.4 Aliases are empty in the first build

The `aliases` field exists in the schema but is **populated as empty in v1**. Deriving
alternate names from redirects requires `enwiki-latest-redirect.sql.gz`, which is not part
of the available input data. The field is retained so the artifact format does not have to
change when redirects are added later.

No stub or placeholder values are written. An empty array means "not computed yet", and
consumers must not infer that a concept has no alternates.

### 4.5 Artifacts

| File | Size | Contents |
|---|---|---|
| `concepts.json` | ~6 MB | `{ version, dumpDate, nodeCount, nodes: Concept[] }` — the tree; `parent` index makes this self-sufficient |
| `crosslinks.json` | ~4 MB | `{ edges: [srcIdx, dstIdx, sharedArticles][] }`, deduplicated, undirected |
| `layout.bin` | ~0.7 MB | precomputed geometry (below) |
| `meta.json` | <1 KB | provenance and pruning parameters |

**`layout.bin` binary layout**, all little-endian, concatenated:

| Section | Type | Length |
|---|---|---|
| node x | `Float32Array` | `nodeCount` |
| node y | `Float32Array` | `nodeCount` |
| tree edge src | `Uint16Array` | `nodeCount - roots` |
| tree edge dst | `Uint16Array` | `nodeCount - roots` |
| crosslink src | `Uint16Array` | `crosslinkCount` |
| crosslink dst | `Uint16Array` | `crosslinkCount` |
| crosslink weight | `Float32Array` | `crosslinkCount` |

Node indices are `Uint16`, capping the atlas at **65,535 concepts**. `layout.mjs` must fail
with a clear error if the node count exceeds this; it is a hard format limit, not a
soft warning.

---

## 5. Ingest

### 5.1 Source parsing

Both dumps are SQL with multi-row `INSERT` statements. Both are streamed and parsed
line-by-line; neither is ever fully loaded into memory.

- **`enwiki-latest-page.sql.gz`** — build `page_id → category name` for every page whose
  `page_namespace = 14` (the Category namespace). This set is the definition of "is a
  category".
- **`enwiki-latest-categorylinks.sql.gz`** — for each row, if `page_id` belongs to the
  namespace-14 set, emit edge `(page_title → category)`. Simultaneously increment
  `articleCount[category]` for **every** row, namespace-14 or not.

`articleCount` is the significance signal and is available for free from the same stream.

### 5.2 Pass 1 — meta filter

Drop maintenance and meta categories by pattern match against the category name:

`^CS\d`, `^WikiProject`, `^Wikipedia `, `^Templates? `, `^Use dmy`, `^Articles with `,
`^Stub`, `^Undated`, `^Interwiki`, `^Commons `, `^All `, `disambiguation`,
bare-year and bare-year-span (`^(1[89]|20)\d\d$`, `^(1[89]|20)\d\d[_ -]s?$`), and names
ending in a parenthesised maintenance note.

This pass requires no graph structure and runs first on the raw name list.

`^All ` is deliberately included despite catching some legitimate categories such as
`All films`: in practice the maintenance categories dominate, and `articleCount` ranking
(§5.2 pass 4) recovers genuinely substantial survivors. This list is a tunable heuristic
and `/method` reports it verbatim.

### 5.3 Pass 2 — primary parent selection

The category graph is a **DAG**, not a tree: any category may sit under several parents.
The atlas assigns exactly one *primary* parent so it reads as a hierarchy; every other
parent becomes a cross-link (§6).

For each node, among candidate parents:

1. **Primary = largest subtree.** The dominant context. `Physics` correctly wins over
   `History of Physics` when both contain `Thermodynamics`. Subtree size is the total node
   count beneath a node in the forest being built; computed bottom-up once the assignment
   is complete, then verified against a second pass.
2. **Tie-break: shallower parent depth.**
3. **Final tie-break: parent name, ascending.** Makes selection deterministic so builds are
   reproducible.

**Cycle breaking.** Primary-parent selection can close a loop, because the underlying graph
has loops. Any cycle is broken by demoting its lowest-scoring edge (by the ordering above)
to a cross-link. `prune.mjs` asserts the result is acyclic and fails the build otherwise.

This pass yields a forest. Depth is now well-defined (§4.2).

### 5.4 Pass 3 — depth cap at 5

Categories deeper than 5 are re-parented to their depth-5 ancestor and removed. Wikipedia
contains long chains of the form `Category:X` → `Category:X in Y` → `Category:X in Y in Z`.

Re-parenting to the depth-5 ancestor preserves connectivity and keeps the node reachable.

### 5.5 Pass 4 — rank and cut

Sort surviving nodes by `articleCount` descending and keep the top 30,000.

`articleCount` is the significance signal: a category holding many articles is a real,
substantial field, while one holding two is usually a navigational ghost.

### 5.6 Pass 5 — restore ancestors

Any ancestor required to make a kept node reachable from a root is pulled back in, even if
it did not survive the rank cut. Ancestors restored this way are exempt from the 30,000
cap; the count of restored nodes is reported in `meta.json`.

The result is guaranteed connected and acyclic.

---

## 6. Cross-links

The cross-link layer is what makes this an atlas rather than a list. Hierarchy shows
nesting; cross-links show **actual contact between fields**.

Articles belong to many categories. If the article *Entropy* is filed under both
Thermodynamics and Information Theory, those two fields are genuinely related — and no
hierarchy would ever surface that.

**Computation — two passes over `categorylinks.sql.gz`.**

The eligibility threshold depends on `articleCount`, which is not known until pass 1 has
finished streaming the whole file. The 2.4 GB gzip is therefore decompressed and streamed
**twice**: once in `ingest.mjs` to compute counts, once in `crosslink.mjs` to collect
membership. This is acceptable because both passes run locally and off the critical path.

On the second pass, for categories with `articleCount >= 10`, record up to 200 member
articles each. Build an inverted `article → [categoryIdx]` index. For each article, emit all
pairs of its categories, counting shared articles per pair. Keep pairs with **≥ 3 shared
articles**, truncated to the **top 20 by shared count** per category. Deduplicate
undirected pairs. Global cap: 400,000 retained edges.

Non-primary parent edges (§5.3) are merged into `crosslinks.json` alongside these, marked by
weight, so both kinds of relationship render in one layer.

**Rationale for the thresholds:** ≥3 shared articles filters coincidental overlap; top-20
keeps the graph legible and the payload bounded; `articleCount >= 10` restricts computation
to categories substantial enough for their neighbours to be meaningful.

---

## 7. Layout

Computed offline in `layout.mjs`, never in the browser.

- `d3.forceSimulation`, run with `.stop()`, then `.tick(150)`.
- Tuned for throughput: `theta: 0.9`, no `forceCollide` on the settling pass (collide is
  roughly 30% of cost and matters little for a knowledge graph), `alphaDecay: 0.05`.
- Deterministic — seeded RNG — so identical input yields identical output.
- Node radius scales with `log(articleCount)`; colour derives from the top-level trunk.

**Measured basis:** at 10k nodes / 40k edges, default d3-force costs ~111 ms per tick
(≈9 fps) and ~33 s total — unusable live. At 30k this is proportionally worse. Layout must
therefore be precomputed. Runtime cost is then only fetch + render.

**Caching.** `layout.mjs` content-hashes its inputs. If the hash matches the hash recorded
in `meta.json`, it reuses the existing `layout.bin` and skips the ~25 s recompute.

---

## 8. Rendering

**The graph view uses sigma.js v3 (WebGL) with static precomputed positions.**

Justification, measured: SVG degrades sharply past ~1,500 animated elements. The existing
`GlobalGraph.svelte` emits two `<circle>` elements per node plus a `<line>` per edge — at
30k nodes that is roughly **210,000 live DOM nodes**, which is not viable. sigma.js v3 is
the maintained WebGL renderer used in production by Gephi Lite, and supplies GPU-side
camera transforms, picking, and hover.

v4 is alpha and WebGL-only; **pin v3**.

`import * as d3 from 'd3'` is retained for the tree views. Measured at ~21 KB gzip, this is
not a real problem in a Vite/Rollup build, provided the namespace is never reified (passed
into functions or dynamically indexed).

---

## 9. Views

Four routes.

### `/` — Browse the trunk

Expandable D3 collapsible tree of the top-level trunks, collapsed to the roots on load.
Side rail jumps directly to any top-level trunk. Search box filters and highlights matches,
auto-expanding ancestors and panning to the first hit.

Each node displays `articleCount`, so a field's substance is visible before opening it.

This reuses the existing `DomainExplorer.svelte` interaction model — collapsed tree, zoom,
search, pan-to-match — which already works. The change is the data source and the count
label, not the interaction.

### `/domains/[slug]` — Field page

The page that does the actual teaching. Four stacked sections:

1. **Header** — breadcrumb path from root, name, `articleCount`, subtree size, depth.
2. **Children** — sorted by `articleCount` descending, so the most substantial subfields
   appear first rather than alphabetically.
3. **Also appears under** — the non-primary parents. This is where *Thermodynamics* admits
   it also sits under *Engineering*. Hierarchies conceal this; surfacing it is the
   difference between a list and an atlas.
4. **Related fields** — top cross-link neighbours by shared-article count, which is how
   cross-domain contact becomes visible.

### `/graph` — Constellation

Full atlas, all ~30,000 nodes, precomputed positions.

- Filter by depth and minimum article count
- Type a name → camera flies to that node
- Click a node → dim everything except its neighbourhood; light the path back to the root
- Hover → tooltip with name and article count

### `/method` — Provenance

Dump date, exact pruning parameters, what was filtered and at what threshold, source
licenses. Required for trust, and cheap to generate from `meta.json`.

`meta.json` carries **every** threshold from every pass — the §5.2 meta-filter pattern list,
the §5.4 depth cap, the §5.5 node target, and the §6 cross-link parameters — so `/method`
renders from a single file with no duplicated constants in the UI layer.

Navigation is a minimal bar: **BROWSE / GRAPH / METHOD**. No name, no tagline, no wordmark.

---

## 10. Module boundaries

```
src/lib/artifacts/          ONLY layer aware of file formats
  types.ts                  Concept, TreeEdge, CrossLink
  load.ts                   loadConcepts, loadEdges, loadLayout
  graph.ts                  ancestorsOf, descendantsOf, subtreeSize, buildIndex

src/components/tree/
  CollapsibleTree.svelte    d3 layout, zoom, transitions
  TreeNode.svelte           label + articleCount + expand affordance

src/components/graph/
  Atlas.svelte              thin mount/unmount wrapper, no layout logic
  atlas-controller.ts       sigma setup, camera, filters, picking — framework-agnostic

src/components/search/
  SearchBox.svelte          input + results

src/components/field/
  FieldHeader.svelte
  ChildList.svelte
  CrossLinks.svelte

src/components/layout/
  BaseLayout.astro          existing, branding removed
  TopBar.astro
```

`src/lib/artifacts/` is the only module that knows files exist. Components consume typed
objects. Replacing the pipeline or the upstream source requires no change to any `.svelte`
file.

**Search** is a zero-dependency linear scan over the name/alias arrays. At 30,000 short
strings this measures ~10 ms — fast enough for instant-as-you-type. A search library would
add a dependency and a megabyte of payload for no gain at this scale.

**Dependencies to remove:** `reactflow` (a React library in a Svelte project, entirely
unused), `dagre` (unused), `marked` (unused). `zod` is retained for artifact validation.

**Dependencies to add:** `sigma@^3` + `graphology` (graph rendering), `better-sqlite3` (local
ingest and cross-link counting — far faster than JS Maps for the pair-counting step, and
written for exactly this shape of workload), `vitest` (unit and fixture tests),
`@playwright/test` (smoke tests). All are dev-time or client-side; none is bundled into the
graph payload except sigma itself, which is lazy-loaded on the `/graph` route only.

---

## 11. Error handling

**The build fails loudly on malformed artifacts.** The current `content-loader.ts` catches
Zod errors, logs, and continues — silently shipping a broken atlas. That behaviour is
inverted. A malformed artifact aborts the build.

**Dangling edges** — an edge referencing a node absent from `concepts.json` — are dropped
at build time, and the count is printed. They are never discovered at runtime by a user
following a broken link.

**Missing or corrupt `layout.bin`** degrades gracefully: `/graph` renders an explanatory
message, and `/` and `/domains/[slug]` continue to work. The tree is the primary experience
and must not depend on the graph layer.

**Cycle breaking must be exhaustive.** A cycle surviving into `concepts.json` would make the
tree infinitely deep on render. `prune.mjs` asserts acyclicity and fails the build if one
survives.

---

## 12. Testing

Tests target the algorithms, which is where the actual risk lives. Components are thin.

**Unit — `scripts/__tests__/`**

| File | Asserts |
|---|---|
| `prune.test.ts` | meta filter matches the real patterns; depth cap re-parents to the correct ancestor; rank-and-restore leaves a connected, acyclic forest |
| `cycle.test.ts` | a synthetic cyclic category graph is broken; every node still reaches a root |
| `crosslink.test.ts` | shared-article counting is correct; the ≥3 threshold is enforced; top-20 truncation holds; pairs are deduplicated and undirected |
| `parent.test.ts` | largest-subtree selection, tie-breaks, and determinism across runs |

**Fixture test.** A ~50-line synthetic category dump containing a known cyclic edge, a
maintenance category, and a deep chain, run through all four scripts end to end in under a
second. This makes the pipeline testable without the 4.6 GB.

**Contract test.** Every edge endpoint exists in `concepts.json`; `layout.bin` node count
equals `concepts.json` node count; `meta.json` counts agree with the artifacts.

**Playwright smoke.** Each route loads without console errors; the tree expands; search
returns results; the graph canvas mounts and a node is clickable.

---

## 13. Explicitly out of scope

Deferred, deliberately, to a later specification:

- Wikidata ingestion (the 103 GB dump cannot be fetched inside a 10-minute Pages build)
- Concept descriptions or prose
- MeSH / Getty AAT / AGROVOC vertical vocabularies
- User accounts, progress tracking, learning paths
- A content authoring interface

---

## 14. Method reference

The category-hierarchy extraction follows the method documented at
`https://stackoverflow.com/questions/17432254/wikipedia-category-hierarchy-from-dumps/77313490`,
which is the approach used by the `wikipedia-cattree` project that inspired this one.

Category names are short factual labels. Licensing obligations for the derived work are
acknowledged in `/method`; the project is released as fully open source.