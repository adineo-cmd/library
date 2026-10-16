<script lang="ts">
  /**
   * The browse view: the atlas as an indented list of rows.
   *
   * The artifact is a forest — 30,039 nodes, 5,330 of them roots — so a
   * single "tree" is the wrong mental model and a nested <ul> per root would
   * be 5,330 subtrees of DOM. Instead this flattens the forest into rows where
   * depth is indentation, which is the index idiom this content actually is
   * and costs one element per visible row instead of one per ancestor.
   *
   * Rows render lazily: only expanded branches produce children. The artifact
   * has 24,709 internal nodes, so rendering every row up front would put tens
   * of thousands of nodes in the DOM for no reason.
   */
  import { onMount } from 'svelte';
  import { loadConcepts } from '../../lib/artifacts/load';
  import type { Concept } from '../../lib/artifacts/types';

  const ARTIFACT = '/data/artifacts/concepts.json';

  let nodes: Concept[] = [];
  let childrenOf: number[][] = [];
  let rootCount = 0;
  let error: string | null = null;
  let loading = true;

  // Roots sorted by reach so the biggest trunks of the atlas come first. The
  // artifact stores nodes in the order the rank cut emitted them, which is by
  // weight already, but sorting explicitly keeps this correct if that changes.
  let roots: number[] = [];

  let query = '';
  let expanded = new Set<number>();
  let selected: number | null = null;

  // Rows currently in view, flattened from the expanded set.
  let rows: { i: number; depth: number }[] = [];

  /** Longest ancestor chain of i, capped so one deep branch cannot recurse
   *  5 levels of component frames per keystroke. */
  function ancestors(i: number): number[] {
    const out: number[] = [];
    let n = nodes[i]?.parent ?? -1;
    while (n !== -1 && n !== undefined && out.length < 64) {
      out.push(n);
      n = nodes[n].parent;
    }
    return out;
  }

  function rebuildRows() {
    const next: { i: number; depth: number }[] = [];

    if (query.trim()) {
      // Search replaces the tree rather than filtering it: the user is looking
      // for a specific category, and the path to it matters more than the
      // forest shape.
      const q = query.trim().toLowerCase();
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].name.toLowerCase().includes(q)) next.push({ i, depth: 0 });
      }
    } else {
      const walk = (i: number, depth: number) => {
        next.push({ i, depth });
        if (!expanded.has(i)) return;
        for (const kid of childrenOf[i] ?? []) walk(kid, depth + 1);
      };
      for (const r of roots) walk(r, 0);
    }
    rows = next;
  }

  /** The match path for one node, root-first, so the result can show where it
   *  sits instead of leaving the user to find it again. */
  function pathOf(i: number): number[] {
    return [...ancestors(i)].reverse().concat(i);
  }

  function toggle(i: number) {
    const next = new Set(expanded);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    expanded = next;
    rebuildRows();
  }

  function select(i: number) {
    selected = selected === i ? null : i;
    if (selected !== null) {
      // Opening a node from search should reveal where it lives.
      if (query.trim()) {
        expanded = new Set([...expanded, ...pathOf(i)]);
      }
    }
    rebuildRows();
  }

  function expandAllVisible() {
    const next = new Set(expanded);
    for (const r of rows) next.add(r.i);
    expanded = next;
    rebuildRows();
  }

  function collapseAll() {
    expanded = new Set();
    rebuildRows();
  }

  function onSearch(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value;
    rebuildRows();
  }

  function onKey(e: KeyboardEvent, i: number) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(i);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!expanded.has(i)) toggle(i);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (expanded.has(i)) toggle(i);
      else {
        const p = nodes[i].parent;
        if (p !== -1) select(p);
      }
    }
  }

  const fmt = (n: number) => n.toLocaleString('en-US');

  /**
   * How much of the atlas a node actually opens up: its own descendants plus,
   * for a root, those descendants' descendants. Ordering roots on
   * `articleCount` alone looked right and was not — 4,936 of the 5,330 roots
   * are childless leaves and the biggest by article count are almost all of
   * those, so only 6 of the top 50 had anything to expand.
   *
   * Ordering on immediate descendants alone is also wrong: `Category table of
   * contents tracking` holds exactly one child but reaches 16,561 categories
   * through it, so a depth-1 count ranks it top and the list opens on a
   * three-article bookkeeping node. Counting the whole subtree puts a real hub
   * first, which is what a tree view is for. Filtering that node out of the
   * data instead was measured and rejected: its descendants are real subjects,
   * and removing it promotes all 16,561 of them to roots (5,330 -> 21,891).
   */
  function reachableSize(i: number): number {
    const seen = new Set<number>();
    let frontier = [i];
    let total = 0;
    // The depth cap bounds this at 6 levels; the seen-set is belt-and-braces
    // against a cycle surviving the artifact.
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next: number[] = [];
      for (const n of frontier) {
        for (const kid of childrenOf[n] ?? []) {
          if (seen.has(kid)) continue;
          seen.add(kid);
          next.push(kid);
        }
      }
      total += next.length;
      frontier = next;
    }
    return total;
  }

  onMount(async () => {
    try {
      const res = await fetch(ARTIFACT);
      if (!res.ok) throw new Error(`concepts.json responded ${res.status}`);
      const file = loadConcepts(await res.json());
      nodes = file.nodes;
      rootCount = file.nodes.length - file.nodes.filter(n => n.parent !== -1).length;

      childrenOf = Array.from({ length: nodes.length }, () => [] as number[]);
      const found: number[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].parent;
        if (p === -1 || p === i || p < 0 || p >= nodes.length) found.push(i);
        else childrenOf[p].push(i);
      }
      // Assign to the component-level binding, not a local: `const roots`
      // here would shadow it and leave `rebuildRows` walking an empty list,
      // which renders a populated-looking toolbar above an empty tree.
      roots = found;
      const sizes = new Map<number, number>();
      for (const r of roots) sizes.set(r, reachableSize(r));
      // Reach first, article count as the tie-break. A root that opens 16,561
      // categories is worth leading with over one holding 16,000 articles of
      // its own, because the first is a place you can go and the second is a
      // leaf you cannot descend from.
      roots.sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0)
        || nodes[b].articleCount - nodes[a].articleCount);

      // Nothing is auto-expanded. The largest root reaches 16,561 categories,
      // so opening it by default put 21,891 rows in the DOM before the reader
      // had clicked anything, and the first thing on screen was a bookkeeping
      // category rather than an invitation. Landing on the root index — the
      // atlas's table of contents, hubs first — is both cheaper and clearer.
      rebuildRows();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });
</script>

<div class="tree">
  {#if loading}
    <p class="state" role="status">Reading the atlas…</p>
  {:else if error}
    <div class="state state--error" role="alert">
      <p>The atlas could not be loaded.</p>
      <p class="state__detail num">{error}</p>
      <p class="state__hint">
        Build the artifacts first: <code>npm run build:artifacts</code>
      </p>
    </div>
  {:else}
    <div class="toolbar">
      <div class="search">
        <span class="search__icon" aria-hidden="true">⌕</span>
        <input
          type="search"
          value={query}
          oninput={onSearch}
          placeholder="Search {fmt(nodes.length)} categories"
          aria-label="Search categories"
        />
      </div>
      <div class="toolbar__meta num">
        {#if query.trim()}
          {fmt(rows.length)} match{rows.length === 1 ? '' : 'es'}
        {:else}
          {fmt(rootCount)} roots · {fmt(nodes.length)} categories
        {/if}
      </div>
      {#if !query.trim()}
        <div class="toolbar__actions">
          <button type="button" onclick={expandAllVisible}>Expand shown</button>
          <button type="button" onclick={collapseAll}>Collapse</button>
        </div>
      {/if}
    </div>

    <div class="tree-body">
    {#if rows.length === 0 && query.trim()}
      <p class="state" role="status">
        No category matches “{query.trim()}”.
      </p>
    {:else if rows.length === 0}
      <p class="state" role="status">
        Nothing to show. Every branch is collapsed — expand one to begin.
      </p>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
      <ul class="rows" role="tree" aria-label="Category tree">
        {#each rows as row (row.i)}
          {@const node = nodes[row.i]}
          {@const kids = childrenOf[row.i]}
          {@const isOpen = expanded.has(row.i)}
          {@const isSel = selected === row.i}
          <li
            class="row"
            class:row--selected={isSel}
            role="treeitem"
            aria-expanded={kids.length ? isOpen : undefined}
            aria-selected={isSel}
            tabindex={row.i === (rows[0]?.i) ? 0 : -1}
            style={`--indent:${row.depth}`}
            onclick={() => select(row.i)}
            onkeydown={(e) => onKey(e, row.i)}
          >
            <span class="row__indent" aria-hidden="true"></span>

            {#if kids.length}
              <button
                type="button"
                class="row__twisty"
                class:row__twisty--open={isOpen}
                aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                onclick={(e) => { e.stopPropagation(); toggle(row.i); }}
              >
                <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
                  <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                </svg>
              </button>
            {:else}
              <span class="row__twisty row__twisty--leaf" aria-hidden="true"></span>
            {/if}

            <span class="row__name">{node.name}</span>

            {#if node.aliases?.length}
              <span class="row__alias">also {node.aliases.join(', ')}</span>
            {/if}

            <span class="row__count num">{fmt(node.articleCount)}</span>
            <span class="row__depth num" title="depth in the tree">d{node.depth}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if selected !== null}
      {@const s = nodes[selected]}
      <aside class="detail" aria-live="polite">
        <div class="detail__head">
          <h2 class="detail__name">{s.name}</h2>
          <button type="button" class="detail__close" onclick={() => select(selected)}>Close</button>
        </div>
        <dl class="detail__stats">
          <div><dt>Articles</dt><dd class="num">{fmt(s.articleCount)}</dd></div>
          <div><dt>Depth</dt><dd class="num">{s.depth}</dd></div>
          <div><dt>Children</dt><dd class="num">{fmt(childrenOf[selected].length)}</dd></div>
        </dl>
        <p class="detail__path">
          {#each pathOf(selected) as p, i (p)}
            {#if i > 0}<span class="detail__sep" aria-hidden="true">/</span>{/if}
            <button type="button" class="detail__crumb" onclick={() => { query = nodes[p].name; rebuildRows(); }}>{nodes[p].name}</button>
          {/each}
        </p>
        <p class="detail__wp">
          <a href={`https://en.wikipedia.org/wiki/Category:${encodeURIComponent(s.name.replace(/ /g, '_'))}`}
             target="_blank" rel="noopener noreferrer">Read this category on Wikipedia ↗</a>
        </p>
      </aside>
    {/if}
    </div>
  {/if}
</div>

<style>
  .tree {
    --row-h: 30px;
  }

  .state {
    padding: 48px 0;
    color: var(--text-muted);
    font-size: 14px;
  }

  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }
  .state__hint { color: var(--text-muted); font-size: 13px; }
  .state__hint code {
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    padding: 2px 6px;
    border-radius: 2px;
    color: var(--text-secondary);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px 24px;
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    z-index: 2;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 9px 14px;
    flex: 1 1 260px;
    max-width: 420px;
  }
  .search:focus-within { border-color: var(--accent); }
  .search__icon { color: var(--text-muted); }
  .search input {
    background: none; border: none; outline: none;
    color: var(--text-primary); font-family: var(--font-body);
    font-size: 13px; width: 100%;
  }
  .search input::placeholder { color: var(--text-muted); }

  .toolbar__meta { color: var(--text-muted); font-size: 11px; }
  .toolbar__actions { display: flex; gap: 8px; margin-left: auto; }
  .toolbar__actions button {
    background: none; border: 1px solid var(--line); color: var(--text-muted);
    font-family: var(--font-body); font-size: 11px;
    padding: 6px 12px; border-radius: 2px; cursor: pointer;
    transition: color 0.2s ease, border-color 0.2s ease;
  }
  .toolbar__actions button:hover { color: var(--text-secondary); border-color: var(--line-light); }
  .toolbar__actions button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Rows, not cards: a hairline between rows, no shared radius, no shadow.
     Indent is the only depth cue that matters, and it is positional. */
  .rows { list-style: none; padding: 0; }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--row-h);
    padding-right: 12px;
    border-bottom: 1px solid var(--line);
    cursor: default;
    transition: background-color 0.15s ease;
  }
  .row:hover { background: var(--bg-secondary); }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .row--selected { background: var(--accent-soft); }

  .row__indent {
    flex: none;
    width: calc(var(--indent) * 20px);
    height: 1px;
    background: var(--line-light);
  }

  .row__twisty {
    flex: none;
    width: 18px; height: 18px;
    display: inline-flex; align-items: center; justify-content: center;
    background: none; border: none; padding: 0;
    color: var(--text-muted); cursor: pointer;
    transition: color 0.2s ease, transform 0.2s ease;
  }
  .row__twisty:hover { color: var(--accent); }
  .row__twisty:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; border-radius: 2px; }
  .row__twisty--open { transform: rotate(90deg); }
  .row__twisty--leaf { cursor: default; }
  .row__twisty--leaf::after {
    content: ""; width: 3px; height: 3px; border-radius: 50%;
    background: var(--line-light);
  }

  .row__name {
    font-size: 13px;
    color: var(--text-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* Depth is also carried by weight so the hierarchy survives a long row. */
  .row[style*="--indent:0"] .row__name,
  .row[style*="--indent:1"] .row__name { font-weight: 500; }

  .row__alias {
    font-size: 11px; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .row__count {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .row__depth {
    font-size: 10px;
    color: var(--text-muted);
    width: 22px;
    text-align: right;
  }

  .detail {
    position: sticky;
    bottom: 0;
    margin-top: 24px;
    padding: 20px 24px;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    border-radius: 2px;
  }

  .detail__head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; margin-bottom: 14px;
  }
  .detail__name {
    font-family: var(--font-display);
    font-size: 24px; font-weight: 500; color: var(--text-primary);
  }
  .detail__close {
    background: none; border: 1px solid var(--line); color: var(--text-muted);
    font-size: 11px; padding: 5px 11px; border-radius: 2px; cursor: pointer;
  }
  .detail__close:hover { color: var(--text-secondary); border-color: var(--line-light); }

  .detail__stats { display: flex; flex-wrap: wrap; gap: 28px; margin-bottom: 14px; }
  .detail__stats dt {
    font-family: var(--font-data); font-size: 10px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--text-muted); margin-bottom: 3px;
  }
  .detail__stats dd { font-size: 18px; color: var(--text-primary); }

  .detail__path { font-size: 11px; color: var(--text-muted); margin-bottom: 10px; line-height: 1.9; }
  .detail__sep { margin: 0 6px; color: var(--line-light); }
  .detail__crumb {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--text-secondary); font-family: var(--font-body); font-size: 11px;
  }
  .detail__crumb:hover { color: var(--accent); }
  .detail__crumb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .detail__wp a { color: var(--text-secondary); font-size: 12px; text-decoration: none; }
  .detail__wp a:hover { color: var(--accent); }
  .detail__wp a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (max-width: 640px) {
    .row__depth { display: none; }
    .toolbar__meta { display: none; }
  }
</style>
