<script lang="ts">
  /**
   * The domains index — one card per main domain, in the same idiom as the
   * roadmap index. Clicking a card opens that trunk's tree on
   * /domains/<id>; the tree page is where the wandering happens, this page
   * is the choosing.
   */
  import { onMount } from 'svelte';

  interface Trunk { id: string; name: string; color: string }
  interface Card {
    id: string; name: string; color: string; blurb: string | null;
    domains: number; fields: number; topDomains: string[];
  }

  const BASE = import.meta.env.BASE_URL;
  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';
  let cards: Card[] = [];

  const fmt = (n: number) => n.toLocaleString('en-US');

  onMount(async () => {
    try {
      const res = await fetch(`${BASE}data/artifacts/structure.json`);
      if (!res.ok) throw new Error(`structure.json → ${res.status}`);
      const s = await res.json();
      const kids: number[][] = Array.from({ length: s.nodes.length }, () => []);
      for (let i = 0; i < s.nodes.length; i++) {
        const p = s.nodes[i].parent;
        if (p >= 0) kids[p].push(i);
      }
      cards = s.trunks.map((t: Trunk, ti: number) => {
        const tIdx = s.nodes.findIndex((n: any) => n.kind === 'trunk' && n.trunk === ti);
        const domainIdxs = kids[tIdx] ?? [];
        const fields = s.nodes.reduce(
          (sum: number, n: any) => (n.trunk === ti && n.kind === 'field' ? sum + 1 : sum), 0);
        const domainNames = domainIdxs
          .slice()
          .sort((a, b) => (s.nodes[b].pop ?? 0) - (s.nodes[a].pop ?? 0))
          .map((i: number) => s.nodes[i].name);
        return {
          id: t.id, name: t.name, color: t.color,
          blurb: s.nodes[tIdx]?.description ?? null,
          domains: domainIdxs.length, fields,
          topDomains: domainNames.slice(0, 4),
        };
      });
      status = 'ready';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });
</script>

<div class="index">
  {#if status === 'loading'}
    <p class="state" role="status">Laying out the domains…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The domains could not be loaded.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <div class="search-row">
      <p class="count num">{cards.length} main domains · pick one to see its tree</p>
    </div>

    {#each [
      { name: 'Academic & professional trunks', items: cards.slice(0, 8) },
      { name: 'Sports, trades & daily life', items: cards.slice(8, 11) },
      { name: 'Beyond the trunks', items: cards.slice(11) },
    ] as group (group.name)}
      {#if group.items.length}
        <section class="group">
          <header class="group__head">
            <h2 class="group__name">{group.name}</h2>
            <span class="group__count num">{group.items.length}</span>
          </header>
          <div class="grid">
            {#each group.items as c (c.id)}
              <a class="card" href={`${BASE}domains/${c.id}`} style={`--trunk:${c.color}`}>
                <span class="card__kind">main domain</span>
                <h3 class="card__title">{c.name}</h3>
                {#if c.blurb}
                  <p class="card__desc">{c.blurb}</p>
                {/if}
                <div class="card__chips">
                  {#each c.topDomains as d (d)}
                    <span class="mini">{d}</span>
                  {/each}
                  {#if c.domains > c.topDomains.length}
                    <span class="mini more">+{c.domains - c.topDomains.length}</span>
                  {/if}
                </div>
                <span class="card__meta num">{c.domains} domains · {fmt(c.fields)} fields</span>
              </a>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .state { padding: 40px 0; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }

  .search-row { display: flex; align-items: center; margin: 20px 0 4px; }
  .count { font-size: 11px; color: var(--text-muted); }

  .group { margin-top: 34px; }
  .group__head {
    display: flex; align-items: baseline; gap: 14px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 10px; margin-bottom: 18px;
  }
  .group__name {
    font-family: var(--font-display); font-size: 26px; font-weight: 500;
    color: var(--text-primary);
  }
  .group__count { margin-left: auto; font-size: 11px; color: var(--text-muted); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }
  .card {
    display: flex; flex-direction: column; gap: 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-top: 3px solid var(--trunk);
    border-radius: 10px;
    padding: 16px 18px;
    text-decoration: none;
    transition: transform 0.18s ease, border-color 0.18s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--trunk); }
  .card__kind {
    font-family: var(--font-data); font-size: 9.5px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--trunk);
  }
  .card__title {
    font-family: var(--font-body); font-size: 17px; font-weight: 600;
    color: var(--text-primary); margin: 0;
  }
  .card__desc {
    font-size: 12.5px; color: var(--text-muted); margin: 0; line-height: 1.5;
  }
  .card__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .mini {
    font-size: 10.5px; color: var(--text-secondary);
    border: 1px solid var(--line-light); border-radius: 999px;
    padding: 2px 9px; white-space: nowrap;
  }
  .mini.more { color: var(--text-muted); border-style: dashed; }
  .card__meta { font-size: 10.5px; color: var(--text-muted); margin-top: auto; }
</style>
