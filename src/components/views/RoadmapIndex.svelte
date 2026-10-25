<script lang="ts">
  /**
   * The roadmap index: every learning path in the atlas, searchable.
   *
   * One fetch of roadmaps.json; the grid groups by trunk so the eye can walk
   * a trunk's pathways top to bottom. A hash of a structure node id
   * (/roadmap#domain:sciences/physics) scrolls to and highlights the matching
   * roadmap — that is how the domains view deep-links here.
   */
  import { onMount } from 'svelte';

  interface Entry {
    slug: string; title: string; node: number; kind: string;
    trunk: number; trunkName: string; steps: number; depth: number;
    desc: string | null;
  }

  let entries: Entry[] = [];
  let trunks: { id: string; name: string; num: string; color: string }[] = [];
  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';
  let query = '';
  let highlight = -1;

  $: filtered = query.trim().length >= 2
    ? entries.filter(e =>
        e.title.toLowerCase().includes(query.trim().toLowerCase())
        || (e.desc ?? '').toLowerCase().includes(query.trim().toLowerCase()))
    : entries;

  $: byTrunk = groupByTrunk(filtered);

  function groupByTrunk(list: Entry[]) {
    const groups: { trunk: number; items: Entry[] }[] = [];
    for (const e of list) {
      let g = groups.find(x => x.trunk === e.trunk);
      if (!g) { g = { trunk: e.trunk, items: [] }; groups.push(g); }
      g.items.push(e);
    }
    groups.sort((a, b) => a.trunk - b.trunk);
    return groups;
  }

  onMount(async () => {
    try {
      const [rRes, sRes] = await Promise.all([
        fetch('/data/artifacts/roadmaps.json'),
        fetch('/data/artifacts/structure.json'),
      ]);
      if (!rRes.ok || !sRes.ok) throw new Error('artifact fetch failed');
      const r = await rRes.json();
      const s = await sRes.json();
      entries = r.index;
      trunks = s.trunks;
      status = 'ready';
      const hash = decodeURIComponent(location.hash.slice(1));
      if (hash) {
        const hit = entries.find(e => {
          const n = s.nodes[e.node];
          return n && n.id === hash;
        });
        if (hit) {
          highlight = entries.indexOf(hit);
          queueMicrotask(() =>
            document.getElementById(`rm-${highlight}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });

  const fmt = (n: number) => n.toLocaleString('en-US');
</script>

<div class="index">
  {#if status === 'loading'}
    <p class="state" role="status">Unrolling the pathways…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The roadmaps could not be loaded.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <div class="topbar">
      <div class="search">
        <span class="search__icon" aria-hidden="true">⌕</span>
        <input
          type="search"
          bind:value={query}
          placeholder="search {fmt(entries.length)} roadmaps, e.g. physics, ethics, networks"
          aria-label="Search roadmaps"
        />
      </div>
      <p class="count num">{fmt(filtered.length)} path{filtered.length === 1 ? '' : 's'}</p>
    </div>

    {#each byTrunk as group (group.trunk)}
      {@const t = trunks[group.trunk]}
      <section class="group" id={t?.id} style={`--trunk:${t?.color ?? 'var(--accent)'}`}>
        <header class="group__head">
          <span class="group__num num">{t?.num}</span>
          <h2 class="group__name">{t?.name ?? 'Interdisciplinary'}</h2>
          <span class="group__count num">{group.items.length}</span>
        </header>
        <div class="grid">
          {#each group.items as e (e.slug)}
            {@const hi = entries.indexOf(e)}
            <a
              class="card"
              class:card--hl={hi === highlight}
              id={`rm-${hi}`}
              href={`/roadmap/${e.slug}`}
            >
              <span class="card__kind">{e.kind === 'trunk' ? 'grand tour' : e.kind}</span>
              <h3 class="card__title">{e.title}</h3>
              {#if e.desc}
                <p class="card__desc">{e.desc}</p>
              {/if}
              <span class="card__meta num">{e.steps} steps · {e.depth} level{e.depth === 1 ? '' : 's'}</span>
            </a>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .state { padding: 64px 0; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }

  .topbar {
    display: flex; align-items: center; gap: 18px;
    margin: 24px 0 8px;
  }
  .search {
    display: flex; align-items: center; gap: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 13px 18px;
    flex: 1;
    max-width: 560px;
  }
  .search:focus-within { border-color: var(--accent); }
  .search__icon { color: var(--text-muted); }
  .search input {
    background: none; border: none; outline: none;
    color: var(--text-primary); font-family: var(--font-body);
    font-size: 14px; width: 100%;
  }
  .search input::placeholder { color: var(--text-muted); font-style: italic; }
  .count { font-size: 11px; color: var(--text-muted); }

  .group { margin-top: 40px; }
  .group__head {
    display: flex; align-items: baseline; gap: 14px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 10px; margin-bottom: 18px;
  }
  .group__num { font-size: 13px; color: var(--trunk); }
  .group__name {
    font-family: var(--font-display); font-size: 26px; font-weight: 500;
    color: var(--text-primary);
  }
  .group__count { margin-left: auto; font-size: 11px; color: var(--text-muted); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 14px;
  }
  .card {
    display: flex; flex-direction: column; gap: 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px 18px;
    text-decoration: none;
    transition: transform 0.18s ease, border-color 0.18s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--trunk); }
  .card--hl { border-color: var(--trunk); box-shadow: 0 0 0 1px var(--trunk); }
  .card__kind {
    font-family: var(--font-data); font-size: 9.5px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--trunk);
  }
  .card__title {
    font-family: var(--font-body); font-size: 15.5px; font-weight: 500;
    color: var(--text-primary); margin: 0;
  }
  .card__desc {
    font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .card__meta { font-size: 10.5px; color: var(--text-muted); margin-top: auto; }
</style>
