<script lang="ts">
  /**
   * The domains view: every field branches from one curiosity.
   *
   * Top: a two-level fan — root to trunks to domains — in the atlas idiom.
   * Below: one section per trunk; each domain in it opens into its own
   * section, listing the curated subdomains and the Wikidata fields that
   * landed underneath. "Each subdomain has its own section" is literal: the
   * domain row, its fan and its fields are one block per domain.
   */
  import { onMount } from 'svelte';

  interface Node {
    index: number; id: string; name: string; description: string | null;
    wiki: string | null; parent: number; trunk: number; kind: string; size: number;
  }
  interface Trunk { id: string; name: string; num: string; color: string }

  let nodes: Node[] = [];
  let trunks: Trunk[] = [];
  let kids: number[][] = [];
  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';

  let query = '';
  let openDomain: number | null = null;

  const fmt = (n: number) => n.toLocaleString('en-US');

  const childrenOf = (i: number) => kids[i] ?? [];
  const domainsOfTrunk = (ti: number) =>
    childrenOf(trunkRoot(ti)).filter(k => nodes[k].kind === 'domain');
  const trunkRoot = (ti: number) => trunkRootIdx[ti] ?? -1;
  let trunkRootIdx: number[] = [];

  // Field children of a domain, best first.
  const fieldsOf = (i: number) =>
    childrenOf(i).filter(k => nodes[k].kind === 'field')
      .sort((a, b) => (nodes[b].size) - (nodes[a].size)).slice(0, 12);
  const subsOf = (i: number) => childrenOf(i).filter(k => nodes[k].kind === 'subdomain');


  // Fan geometry: every domain of every trunk gets its own row down the
  // right edge; a trunk's y is the mean of its domains' rows. Labels can
  // never collide because no two nodes share a row.
  function fanLayout() {
    const TOP = 22;
    const H = 560;
    const rows: { node: number; label: string; trunk: number }[] = [];
    trunks.forEach((t, ti) => {
      for (const d of domainsOfTrunk(ti)) {
        rows.push({ node: d, label: `${t.num}-${String(rows.length + 1).padStart(2, '0')}  ${nodes[d].name}`, trunk: ti });
      }
    });
    const yOf = (i: number) => TOP + ((H - TOP * 2) * i) / Math.max(1, rows.length - 1);
    const out = trunks.map((t, ti) => {
      const idxs = rows.map((r, i) => ({ r, i })).filter(x => x.r.trunk === ti);
      const y = idxs.length
        ? idxs.reduce((s, x) => s + yOf(x.i), 0) / idxs.length
        : H / 2;
      return {
        id: t.id, num: t.num, name: t.name, color: t.color,
        x: 330, y,
        domains: idxs.map((x, di) => ({
          node: x.r.node, x: 640, y: yOf(x.i),
          label: `${t.num}-${String(di + 1).padStart(2, '0')} ${nodes[x.r.node].name}`,
        })),
      };
    });
    return { trunks: out, rootY: H / 2, h: H };
  }

  // Search: every node by name — domains, subdomains and all ~8.7k fields.
  $: layout = status === 'ready' ? fanLayout() : { trunks: [], rootY: 280, h: 560 };
  $: matches = query.trim().length >= 2
    ? nodes.filter(n => n.kind !== 'trunk'
        && n.name.toLowerCase().includes(query.trim().toLowerCase()))
    : null;

  function toggleDomain(i: number) {
    openDomain = openDomain === i ? null : i;
    if (openDomain !== null) {
      queueMicrotask(() => {
        document.getElementById(`domain-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  onMount(async () => {
    try {
      const res = await fetch('/data/artifacts/structure.json');
      if (!res.ok) throw new Error(`structure.json responded ${res.status}`);
      const s = await res.json();
      nodes = s.nodes.map((n: any, index: number) => ({ ...n, index }));
      trunks = s.trunks;
      kids = Array.from({ length: nodes.length }, () => [] as number[]);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].parent;
        if (p >= 0) kids[p].push(i);
      }
      trunkRootIdx = trunks.map((_, ti) => nodes.findIndex(n => n.kind === 'trunk' && n.trunk === ti));
      // Deep-link: /domains#sciences opens the trunk section.
      const hash = decodeURIComponent(location.hash.slice(1));
      if (hash) {
        const ti = trunks.findIndex(t => t.id === hash);
        if (ti >= 0) queueMicrotask(() =>
          document.getElementById(trunks[ti].id)?.scrollIntoView({ behavior: 'smooth' }));
      }
      status = 'ready';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });
</script>

<div class="map">
  {#if status === 'loading'}
    <p class="state" role="status">Charting the domains…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The atlas could not be loaded.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <!-- search -->
    <div class="search" role="search">
      <span class="search__icon" aria-hidden="true">⌕</span>
      <input
        type="search"
        bind:value={query}
        placeholder="search 9,261 domains and fields, e.g. physics, cartography, criminology"
        aria-label="Search domains and subdomains"
      />
      {#if matches}
        <span class="search__count num">{fmt(matches.length)} match{matches.length === 1 ? '' : 'es'}</span>
      {/if}
    </div>

    {#if matches}
      <!-- search results replace the fan: the user is looking for one thing -->
      <div class="results">
        {#each matches.slice(0, 80) as m (m.index)}
          <button type="button" class="result" onclick={() => toggleDomain(m.index)}>
            <span class="result__name">{m.name}</span>
            <span class="result__path">{m.kind} · {nodes[m.parent]?.name ?? 'atlas root'}</span>
            <span class="result__num num">{m.kind === 'field' ? 'field' : `${fmt(m.size)} fields`}</span>
          </button>
        {/each}
      </div>
    {:else}
      <!-- the two-level fan: domains get their own row each, trunks sit at
           the mean of their domains' rows, so labels never collide -->
      <div class="fanwrap">
        <svg viewBox="0 0 960 {layout.h}" aria-hidden="true">
          <defs>
            <radialGradient id="rootGlow2">
              <stop offset="0%" stop-color="#e8b76a" stop-opacity="0.5" />
              <stop offset="100%" stop-color="#e8b76a" stop-opacity="0" />
            </radialGradient>
          </defs>
          <circle cx="110" cy={layout.rootY} r="120" fill="url(#rootGlow2)" />
          {#each layout.trunks as T}
            <path d="M 110 {layout.rootY} C 200 {layout.rootY}, {T.x - 80} {T.y}, {T.x} {T.y}"
              fill="none" stroke="var(--line-light)" stroke-width="1" />
            {#each T.domains as D}
              <path d="M {T.x} {T.y} C {T.x + 70} {T.y}, {D.x - 55} {D.y}, {D.x} {D.y}"
                fill="none" stroke="var(--line)" stroke-width="0.8" />
              <circle cx={D.x} cy={D.y} r="3" fill={T.color} opacity="0.85" />
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <text class="fan-domain" x={D.x + 9} y={D.y + 3.5}
                onclick={() => toggleDomain(D.node)}>
                {D.label}
              </text>
            {/each}
            <a href={`#${T.id}`}>
              <circle cx={T.x} cy={T.y} r="5.5" fill={T.color} />
              <text class="fan-trunk" x={T.x + 12} y={T.y + 4}>{T.num} {T.name}</text>
            </a>
          {/each}
          <circle cx="110" cy={layout.rootY} r="9" fill="#e8b76a" />
          <text class="fan-root" x="126" y={layout.rootY + 5}>Domain</text>
        </svg>
        <p class="fan-hint">Pick a trunk — the atlas fans out into the domains, subdomains, and adjacent disciplines waiting to be explored.</p>
      </div>

      <!-- per-trunk sections -->
      {#each trunks as t, ti (t.id)}
        <section class="trunk-sec" id={t.id} style={`--trunk:${t.color}`}>
          <header class="trunk-sec__head">
            <span class="trunk-sec__num num">{t.num}</span>
            <h2 class="trunk-sec__name">{t.name}</h2>
            <span class="trunk-sec__meta num">{fmt(domainsOfTrunk(ti).length)} domains</span>
          </header>

          <div class="domains">
            {#each domainsOfTrunk(ti) as d (nodes[d].index)}
              {@const subs = subsOf(d)}
              {@const fields = fieldsOf(d)}
              {@const isOpen = openDomain === d}
              <article class="domain" class:open={isOpen} id={`domain-${d}`}>
                <button
                  type="button"
                  class="domain__row"
                  aria-expanded={isOpen}
                  onclick={() => toggleDomain(d)}
                >
                  <span class="domain__dot" aria-hidden="true"></span>
                  <span class="domain__name">{nodes[d].name}</span>
                  {#if nodes[d].description}
                    <span class="domain__blurb">{nodes[d].description}</span>
                  {/if}
                  <span class="domain__meta num">{subs.length || fields.length} step{subs.length === 1 && !fields.length ? '' : 's'} →</span>
                </button>

                {#if isOpen}
                  <div class="domain__body">
                    {#if subs.length}
                      <p class="domain__label">The path through {nodes[d].name}</p>
                      <ol class="steps">
                        {#each subs as s, si (s)}
                          <li class="step">
                            <a class="step__num num" href={`/roadmap#${nodes[s].id}`}>{String(si + 1).padStart(2, '0')}</a>
                            <div>
                              <p class="step__name">{nodes[s].name}</p>
                              {#if fieldsOf(s).length}
                                <p class="step__fields">
                                  {fieldsOf(s).slice(0, 6).map(f => nodes[f].name).join(' · ')}
                                  {fieldsOf(s).length > 6 ? ` · +${fmt(nodes[s].size - 6)} more` : ''}
                                </p>
                              {/if}
                            </div>
                          </li>
                        {/each}
                      </ol>
                    {:else if fields.length}
                      <p class="domain__label">Fields of {nodes[d].name}</p>
                      <ul class="chips">
                        {#each fields as f (f)}
                          <li class="chip">{nodes[f].name}</li>
                        {/each}
                      </ul>
                    {:else}
                      <p class="domain__label">A leaf domain — its fields live in the graph view.</p>
                    {/if}
                    {#if nodes[d].wiki || (fields[0] !== undefined && nodes[fields[0]].wiki)}
                      <p class="domain__more">
                        <a
                          href={nodes[d].wiki
                            ? `https://en.wikipedia.org/wiki/${nodes[d].wiki}`
                            : `https://en.wikipedia.org/wiki/${nodes[fields[0]].wiki}`}
                          target="_blank" rel="noopener noreferrer">Read more on Wikipedia ↗</a>
                      </p>
                    {/if}
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .state { padding: 64px 0; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }

  .search {
    display: flex; align-items: center; gap: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 13px 18px;
    max-width: 640px;
    margin: 20px auto 8px;
  }
  .search:focus-within { border-color: var(--accent); }
  .search__icon { color: var(--text-muted); }
  .search input {
    background: none; border: none; outline: none;
    color: var(--text-primary); font-family: var(--font-body);
    font-size: 14px; width: 100%;
  }
  .search input::placeholder { color: var(--text-muted); font-style: italic; }
  .search__count { color: var(--text-muted); font-size: 11px; white-space: nowrap; }

  .results {
    max-width: 680px; margin: 18px auto;
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
  }
  .result {
    display: flex; align-items: baseline; gap: 12px; width: 100%;
    padding: 11px 16px; text-align: left;
    background: var(--bg-primary); border: none;
    border-bottom: 1px solid var(--line); cursor: pointer;
    color: var(--text-primary);
  }
  .result:last-child { border-bottom: none; }
  .result:hover { background: var(--bg-secondary); }
  .result__name { font-size: 14px; }
  .result__path { font-size: 11px; color: var(--text-muted); flex: 1; }
  .result__num { font-size: 11px; color: var(--text-secondary); }

  .fanwrap { margin: 12px 0 8px; }
  .fanwrap svg { width: 100%; height: auto; display: block; }
  .fan-trunk {
    font-family: var(--font-body); font-size: 14px; fill: var(--text-primary);
  }
  .fan-domain {
    font-family: var(--font-body); font-size: 10.5px; fill: var(--text-secondary);
    cursor: pointer;
  }
  .fan-domain:hover { fill: var(--text-primary); text-decoration: underline; }
  .fan-root {
    font-family: var(--font-display); font-style: italic; font-size: 17px;
    fill: var(--text-primary);
  }
  .fan-hint {
    text-align: center; color: var(--text-muted); font-size: 12.5px;
    max-width: 52ch; margin: 4px auto 0;
  }

  .trunk-sec { margin-top: 44px; }
  .trunk-sec__head {
    display: flex; align-items: baseline; gap: 14px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 12px; margin-bottom: 8px;
  }
  .trunk-sec__num {
    font-size: 13px; color: var(--trunk);
  }
  .trunk-sec__name {
    font-family: var(--font-display); font-size: 30px; font-weight: 500;
    color: var(--text-primary);
  }
  .trunk-sec__meta { margin-left: auto; font-size: 11px; color: var(--text-muted); }

  .domain { border-bottom: 1px solid var(--line); }
  .domain.open { background: var(--bg-secondary); }
  .domain__row {
    display: flex; align-items: baseline; gap: 12px; width: 100%;
    padding: 14px 12px; text-align: left;
    background: none; border: none; cursor: pointer;
    color: var(--text-primary);
  }
  .domain__row:hover { background: var(--bg-tertiary); }
  .domain__dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--trunk); flex: none; align-self: center;
  }
  .domain__name { font-size: 16px; font-weight: 500; white-space: nowrap; }
  .domain__blurb {
    font-size: 12.5px; color: var(--text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
  }
  .domain__meta {
    margin-left: auto; font-size: 11px; color: var(--text-muted); white-space: nowrap;
  }

  .domain__body { padding: 4px 20px 22px 34px; }
  .domain__label {
    font-family: var(--font-data); font-size: 10px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--text-muted); margin-bottom: 12px;
  }

  .steps { list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 28px; padding: 0; }
  .step { display: flex; gap: 12px; }
  .step__num { color: var(--trunk); font-size: 12px; text-decoration: none; padding-top: 2px; }
  .step__num:hover { text-decoration: underline; }
  .step__name { font-size: 13.5px; color: var(--text-primary); }
  .step__fields {
    font-size: 11px; color: var(--text-muted); margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .chips { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; padding: 0; }
  .chip {
    font-size: 12px; color: var(--text-secondary);
    border: 1px solid var(--line-light); border-radius: 999px;
    padding: 4px 12px;
  }

  .domain__more { margin-top: 14px; }
  .domain__more a { font-size: 12px; color: var(--text-secondary); text-decoration: none; }
  .domain__more a:hover { color: var(--accent); }

  @media (max-width: 720px) {
    .domain__blurb { display: none; }
    .steps { grid-template-columns: 1fr; }
  }
</style>
