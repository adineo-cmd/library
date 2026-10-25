<script lang="ts">
  /**
   * The roadmap viewer: a learning path as a picture.
   *
   * The roadmap.sh idiom, rebuilt from the atlas: rows of topic boxes read
   * top to bottom along a drawn spine, each box clickable, each row a level
   * of the path. Clicking a box opens the side panel — description, related
   * fields, the Wikipedia article. Ticking a box records progress in
   * localStorage; the spine fills in as steps are completed.
   *
   * The slug comes from the URL; the roadmap itself is one lookup in
   * roadmaps.json, fetched once and kept.
   */
  import { onMount } from 'svelte';

  const BASE = import.meta.env.BASE_URL;

  interface RNode {
    id: string; label: string; level: number; x: number; y: number;
    kind: 'primary' | 'optional'; desc: string | null; wiki: string | null; size: number;
  }
  interface Roadmap {
    slug: string; node: number; levelCount: number;
    nodes: RNode[]; edges: [number, number][];
  }

  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';
  let roadmap: Roadmap | null = null;
  let trunks: { id: string; name: string; num: string; color: string }[] = [];
  let structureNodes: { name: string; kind: string; trunk: number; wiki: string | null; description: string | null }[] = [];
  let relatedBySlug: number[][] = [];

  let slug = '';
  let done: Set<string> = new Set();
  let selected: number | null = null;
  let showOptional = true;

  const COL_W = 250;
  const ROW_H = 170;
  const NODE_W = 208;
  const NODE_H = 50;

  $: trunk = roadmap ? trunks[structureNodes[roadmap.node]?.trunk ?? 0] : null;
  $: trunkColor = trunk?.color ?? '#e8b76a';

  $: bounds = roadmap ? {
    w: Math.max(...roadmap.nodes.map(n => n.x)) + NODE_W + 140,
    h: Math.max(...roadmap.nodes.map(n => n.y)) + NODE_H + 90,
  } : { w: 800, h: 400 };

  $: levelRows = roadmap ? groupLevels(roadmap) : [];

  function groupLevels(rm: Roadmap) {
    const rows: { level: number; nodes: number[] }[] = [];
    rm.nodes.forEach((n, i) => {
      if (n.kind !== 'primary') return;
      let row = rows.find(r => r.level === n.level);
      if (!row) { row = { level: n.level, nodes: [] }; rows.push(row); }
      row.nodes.push(i);
    });
    rows.sort((a, b) => a.level - b.level);
    return rows;
  }

  $: related = selected !== null ? relatedBySlug[selected] ?? [] : [];

  function storageKey(s: string) { return `arbor-roadmap-${s}`; }

  function toggleDone(nodeId: string) {
    const next = new Set(done);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    done = next;
    try {
      localStorage.setItem(storageKey(slug), JSON.stringify([...next]));
    } catch { /* private mode: progress lives for the session only */ }
  }

  $: doneCount = roadmap ? roadmap.nodes.filter(n => n.kind === 'primary' && done.has(n.id)).length : 0;
  $: pct = roadmap && roadmap.nodes.some(n => n.kind === 'primary')
    ? Math.round((doneCount / roadmap.nodes.filter(n => n.kind === 'primary').length) * 100)
    : 0;

  onMount(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    // ['memex','roadmap','physics'] on Pages, ['roadmap','physics'] locally
    slug = (parts[0] === 'memex' ? parts[2] : parts[1]) ?? '';
    try {
      done = new Set(JSON.parse(localStorage.getItem(storageKey(slug)) ?? '[]'));
    } catch { done = new Set(); }
  });

  onMount(async () => {
    try {
      const [rRes, sRes] = await Promise.all([
        fetch(`${BASE}data/artifacts/roadmaps.json`),
        fetch(`${BASE}data/artifacts/structure.json`),
      ]);
      if (!rRes.ok || !sRes.ok) throw new Error('artifact fetch failed');
      const r = await rRes.json();
      const s = await sRes.json();
      trunks = s.trunks;
      structureNodes = s.nodes;
      const rm = (r.roadmaps as Roadmap[]).find(x => x.slug === slug);
      if (!rm) throw new Error(`no roadmap for “${slug}”`);
      roadmap = rm;
      // related fields per node index, from the atlas crosslinks
      const xlinks: [number, number][] = s.xlinks;
      const rel: number[][] = rm.nodes.map(() => []);
      for (const [a, b] of xlinks) {
        const i = rm.nodes.findIndex(n => n.id === s.nodes[a]?.id && n.kind === 'primary');
        const j = rm.nodes.findIndex(n => n.id === s.nodes[b]?.id);
        if (i >= 0 && j < 0) rel[i].push(b);
        if (j >= 0 && i < 0 && rm.nodes[j]) rel[j].push(a);
      }
      relatedBySlug = rel;
      status = 'ready';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });

  const fmt = (n: number) => n.toLocaleString('en-US');

  /** The spine: a smooth path through the primary nodes in reading order. */
  function spinePath(rm: Roadmap): string {
    const pts = rm.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.kind === 'primary')
      .sort((a, b) => a.n.level - b.n.level || a.n.x - b.n.x)
      .map(({ n }) => [n.x + NODE_W / 2, n.y + NODE_H / 2]);
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const my = (y0 + y1) / 2;
      d += ` C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`;
    }
    return d;
  }
</script>

<div class="view">
  {#if status === 'loading'}
    <p class="state" role="status">Drawing the path…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>This roadmap could not be drawn.</p>
      <p class="state__detail">{error}</p>
      <p class="state__hint"><a href={`${BASE}roadmap`}>← back to all roadmaps</a></p>
    </div>
  {:else if roadmap}
    <header class="head">
      <p class="head__crumb">
        <a href={`${BASE}roadmap`}>Roadmaps</a>
        {#if trunk}<span class="head__sep">/</span><span style={`color:${trunkColor}`}>{trunk.name}</span>{/if}
      </p>
      <h1 class="head__title">{structureNodes[roadmap.node]?.name ?? 'Roadmap'}</h1>
      {#if structureNodes[roadmap.node]?.description}
        <p class="head__desc">{structureNodes[roadmap.node].description}</p>
      {/if}
      <div class="progress">
        <div class="progress__bar"><div class="progress__fill" style={`width:${pct}%`}></div></div>
        <span class="progress__text num">{doneCount}/{roadmap.nodes.filter(n => n.kind === 'primary').length} done · {pct}%</span>
        <label class="opt-toggle">
          <input type="checkbox" bind:checked={showOptional} /> optional fields
        </label>
        <button type="button" class="reset" onclick={() => { done = new Set(); try { localStorage.removeItem(storageKey(slug)); } catch {} }}>
          reset progress
        </button>
      </div>
    </header>

    <div class="stage">
      <svg
        viewBox="0 0 {bounds.w} {bounds.h}"
        role="img"
        aria-label="Learning roadmap for {structureNodes[roadmap.node]?.name}"
      >
        <!-- level rails -->
        {#each levelRows as row (row.level)}
          {@const first = roadmap!.nodes[row.nodes[0]]}
          <text class="rail-label" x={24} y={first.y + NODE_H / 2 + 4}>
            {['Foundations', 'Core', 'Advanced', 'Specialisations', 'Frontiers', 'Further'][row.level] ?? `Level ${row.level + 1}`}
          </text>
        {/each}

        <!-- the spine -->
        <path class="spine" d={spinePath(roadmap)} style={`--trunk:${trunkColor}`} />

        <!-- edges as soft connectors -->
        {#each roadmap.edges as [a, b], ei (ei)}
          {@const na = roadmap!.nodes[a]}
          {@const nb = roadmap!.nodes[b]}
          {#if na && nb && (na.kind === 'primary' || showOptional) && (nb.kind === 'primary' || showOptional)}
            <line
              class="edge"
              class:edge--opt={na.kind === 'optional' || nb.kind === 'optional'}
              x1={na.x + NODE_W / 2} y1={na.y + NODE_H / 2}
              x2={nb.x + NODE_W / 2} y2={nb.y + NODE_H / 2}
            />
          {/if}
        {/each}

        <!-- nodes -->
        {#each roadmap.nodes as n, i (i)}
          {#if n.kind === 'optional' && !showOptional}
            <!-- continue -->
          {:else}
            {@const isDone = done.has(n.id)}
            {@const isSel = selected === i}
            <g
              class="node"
              class:node--opt={n.kind === 'optional'}
              class:node--done={isDone}
              class:node--sel={isSel}
              style={`--trunk:${trunkColor}`}
              onclick={() => { selected = selected === i ? null : i; }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = selected === i ? null : i; } }}
              role="button"
              tabindex="0"
              transform="translate({n.x}, {n.y})"
            >
              <rect
                width={NODE_W} height={NODE_H}
                rx={n.kind === 'optional' ? NODE_H / 2 : 10}
              />
              {#if n.kind === 'primary'}
                <g
                  class="tick"
                  role="checkbox"
                  aria-checked={isDone}
                  tabindex="-1"
                  onclick={(e) => { e.stopPropagation(); toggleDone(n.id); }}
                  onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggleDone(n.id); } }}
>
                  <circle cx={NODE_W - 20} cy={NODE_H / 2} r="8" />
                  {#if isDone}
                    <path class="tick__mark" d={`M ${NODE_W - 24} ${NODE_H / 2} l 3 3 l 6 -7`} />
                  {/if}
                </g>
              {/if}
              <text class="node__label" x="14" y={NODE_H / 2 + 4.5}>
                {n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label}
              </text>
              <title>{n.label}{n.desc ? ` — ${n.desc}` : ''}</title>
            </g>
          {/if}
        {/each}
      </svg>
    </div>

    {#if selected !== null && roadmap.nodes[selected]}
      {@const n = roadmap.nodes[selected]}
      <aside class="panel">
        <header class="panel__head">
          <span class="panel__kind">{n.kind === 'optional' ? 'related field' : `level ${n.level + 1}`}</span>
          <button type="button" class="panel__close" onclick={() => (selected = null)}>close</button>
        </header>
        <h2 class="panel__title">{n.label}</h2>
        <p class="panel__desc">{n.desc ?? 'A field of the atlas — its own entry waits in the domains view.'}</p>
        {#if related.length}
          <p class="panel__label">Related fields</p>
          <ul class="panel__related">
            {#each related.slice(0, 5) as r (r)}
              <li>{structureNodes[r]?.name ?? r}</li>
            {/each}
          </ul>
        {/if}
        {#if n.wiki}
          <a class="panel__wiki" href={`https://en.wikipedia.org/wiki/${n.wiki}`} target="_blank" rel="noopener noreferrer">
            Read on Wikipedia ↗
          </a>
        {/if}
        {#if n.kind === 'primary'}
          <button type="button" class="panel__done" onclick={() => toggleDone(n.id)}>
            {done.has(n.id) ? '✓ completed — untick' : 'mark as done'}
          </button>
        {/if}
      </aside>
    {/if}
  {/if}
</div>

<style>
  .view { position: relative; max-width: 1180px; margin: 0 auto; padding: 0 40px 72px; }

  .state { padding: 64px 0; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }
  .state__hint a { color: var(--text-secondary); font-size: 12px; }

  .head { max-width: 760px; margin-bottom: 8px; }
  .head__crumb { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
  .head__crumb a { color: var(--text-secondary); text-decoration: none; }
  .head__crumb a:hover { color: var(--text-primary); }
  .head__sep { margin: 0 8px; color: var(--line-light); }
  .head__title {
    font-family: var(--font-display); font-size: clamp(30px, 4vw, 46px);
    font-weight: 500; color: var(--text-primary); line-height: 1.1;
  }
  .head__desc { font-size: 14px; color: var(--text-secondary); margin-top: 10px; line-height: 1.6; }

  .progress { display: flex; align-items: center; gap: 14px; margin-top: 16px; }
  .progress__bar {
    width: 220px; height: 6px; border-radius: 3px;
    background: var(--bg-tertiary); overflow: hidden;
  }
  .progress__fill { height: 100%; background: var(--trunk, var(--accent)); transition: width 0.3s ease; }
  .progress__text { font-size: 11px; color: var(--text-muted); }
  .opt-toggle { font-size: 11px; color: var(--text-muted); display: flex; gap: 6px; align-items: center; margin-left: auto; cursor: pointer; }
  .opt-toggle input { accent-color: var(--accent); }
  .reset {
    background: none; border: 1px solid var(--line); border-radius: 6px;
    color: var(--text-muted); font-size: 11px; padding: 4px 10px; cursor: pointer;
  }
  .reset:hover { color: var(--text-secondary); }

  .stage {
    margin-top: 8px;
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg-secondary);
  }
  svg { display: block; min-width: 760px; width: 100%; height: auto; }

  .rail-label {
    font-family: var(--font-data); font-size: 10px; letter-spacing: 0.14em;
    text-transform: uppercase; fill: var(--text-muted);
  }

  .spine {
    fill: none;
    stroke: color-mix(in srgb, var(--trunk) 45%, transparent);
    stroke-width: 3;
    stroke-linecap: round;
  }
  .edge { stroke: var(--line-light); stroke-width: 1.4; }
  .edge--opt { stroke-dasharray: 4 4; stroke: var(--line-light); opacity: 0.7; }

  .node { cursor: pointer; }
  .node rect {
    fill: var(--bg-primary);
    stroke: color-mix(in srgb, var(--trunk) 55%, var(--line-light));
    stroke-width: 1.4;
    transition: fill 0.15s ease;
  }
  .node:hover rect { fill: color-mix(in srgb, var(--trunk) 10%, var(--bg-primary)); }
  .node__label { font-size: 13px; fill: var(--text-primary); font-family: var(--font-body); }
  .node--opt rect { stroke-dasharray: 5 4; stroke: var(--line-light); }
  .node--opt .node__label { fill: var(--text-secondary); font-style: italic; }
  .node--done rect { fill: color-mix(in srgb, var(--trunk) 16%, var(--bg-primary)); }
  .node--sel rect { stroke-width: 2.4; }

  .tick { cursor: pointer; }
  .tick circle { fill: var(--bg-tertiary); stroke: var(--line-light); }
  .node--done .tick circle { fill: var(--trunk); stroke: var(--trunk); }
  .tick__mark { stroke: #10130f; stroke-width: 2; fill: none; }

  .panel {
    position: sticky; bottom: 16px;
    margin-top: 18px;
    background: var(--bg-tertiary);
    border: 1px solid var(--line);
    border-left: 3px solid var(--trunk, var(--accent));
    border-radius: 10px;
    padding: 18px 22px;
  }
  .panel__head { display: flex; justify-content: space-between; align-items: baseline; }
  .panel__kind {
    font-family: var(--font-data); font-size: 9.5px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--text-muted);
  }
  .panel__close {
    background: none; border: none; color: var(--text-muted);
    font-size: 11px; cursor: pointer;
  }
  .panel__close:hover { color: var(--text-secondary); }
  .panel__title { font-family: var(--font-display); font-size: 24px; color: var(--text-primary); margin: 6px 0 4px; }
  .panel__desc { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: 0 0 10px; max-width: 70ch; }
  .panel__label {
    font-family: var(--font-data); font-size: 9.5px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--text-muted); margin: 10px 0 6px;
  }
  .panel__related { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .panel__related li {
    font-size: 11.5px; color: var(--text-secondary);
    border: 1px solid var(--line-light); border-radius: 999px; padding: 3px 10px;
  }
  .panel__wiki { display: inline-block; font-size: 12.5px; color: var(--accent); margin-top: 10px; text-decoration: none; }
  .panel__wiki:hover { text-decoration: underline; }
  .panel__done {
    display: block; margin-top: 14px;
    background: var(--trunk, var(--accent)); color: #10130f;
    border: none; border-radius: 8px; padding: 9px 16px;
    font-size: 12.5px; font-weight: 500; cursor: pointer;
  }

  @media (max-width: 720px) {
    .view { padding: 0 16px 48px; }
    .panel { position: static; }
  }
</style>
