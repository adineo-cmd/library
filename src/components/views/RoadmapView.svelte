<script lang="ts">
  /**
   * The roadmap viewer — a learning path as a horizontal dendrogram.
   *
   * Same pattern as the domains explorer: a D3 left-to-right tree filling
   * the whole viewport, root at the left, one branch per level of the path
   * (Foundations → Core → Advanced → …), topics stacked vertically inside
   * their branch. Clicking a topic opens the notes drawer from the LEFT
   * with its description, Wikipedia link and a done-toggle; completed
   * topics turn green on the tree. Floating glass panels carry the title,
   * the progress pill and the reset button.
   */
  import { onMount } from 'svelte';
  import * as d3 from 'd3';

  interface RNode {
    id: string; label: string; level: number; kind: 'primary' | 'optional';
    desc: string | null; wiki: string | null; size: number;
  }
  interface Roadmap {
    slug: string; node: number; levelCount: number;
    nodes: RNode[]; edges: [number, number][];
  }

  const BASE = import.meta.env.BASE_URL;
  const LEVELS = ['Foundations', 'Core', 'Advanced', 'Specialisations', 'Frontiers', 'Further'];

  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';

  let slug = '';
  let roadmap: Roadmap | null = null;
  let title = '';
  let trunkName = '';
  let trunkColor = '#c9a227';
  let desc = '';

  let done: Set<string> = new Set();
  let doneCount = 0;
  let total = 0;

  // drawer state — the W-questions the notes answer
  let drawerOpen = false;
  let dLabel = '';
  let dKind = '';
  let dLevel = 0;
  let dDesc: string | null = null;
  let dWiki: string | null = null;
  let dDone = false;
  let dExtract: string | null = null;
  let dExtractState: 'idle' | 'loading' | 'ok' | 'none' = 'idle';
  let dSize = 0;
  let dPath = '';
  let dChildren: string[] = [];
  let dRelated: string[] = [];
  let dLevelNames: string[] = [];

  // structure lookups, filled once the artifact lands
  let sNodes: any[] = [];
  let idToIdx = new Map<string, number>();
  let sKids: number[][] = [];
  let sParents: number[] = [];
  const extractCache = new Map<string, string | null>();

  async function fetchExtract(wiki: string | null): Promise<string | null> {
    if (!wiki) return null;
    if (extractCache.has(wiki)) return extractCache.get(wiki)!;
    try {
      const t = wiki.replace(/ /g, '_');
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`);
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      const ex: string | null = j.extract ?? null;
      extractCache.set(wiki, ex);
      return ex;
    } catch {
      extractCache.set(wiki, null);
      return null;
    }
  }

  let xlinks: [number, number][] = [];
  let svg: any, g: any, gLink: any, gNode: any, zoomBehavior: any, root: any;
  let width = 1200, height = 800;
  let stage: HTMLElement;
  let idSeq = 0;

  const fmt = (n: number) => n.toLocaleString('en-US');
  const storageKey = (s: string) => `arbor-roadmap-${s}`;

  const pos = (d: any) => `translate(${d.y},${d.x})`;
  const diagonal = d3.linkHorizontal().x((d: any) => d.y).y((d: any) => d.x);

  function update(source: any, first = false) {
    d3.tree().nodeSize([30, 220])(root);
    const nodesNow = root.descendants();
    const links = root.links();
    const t = first ? 0 : 280;

    const link = gLink.selectAll('path.rlink').data(links, (d: any) => d.target.id);
    link.enter().append('path').attr('class', 'rlink')
      .merge(link).transition().duration(t).attr('d', diagonal);
    link.exit().transition().duration(t).attr('d', diagonal).remove();

    const node = gNode.selectAll('g.rnode').data(nodesNow, (d: any) => d.id);
    const nodeEnter = node.enter().append('g')
      .attr('class', 'rnode')
      .attr('transform', first ? pos : pos(source))
      .attr('opacity', first ? 1 : 0)
      .on('click', (event: any, d: any) => { event.stopPropagation(); clickNode(d); });

    nodeEnter.append('circle')
      .attr('r', (d: any) => d.data.kind === 'root' ? 10 : d.data.kind === 'level' ? 7 : 5)
      .attr('class', (d: any) =>
        `rc rc-${d.data.kind}${d.data.kind === 'topic' && d.data.done ? ' rc-done' : ''}`)
      .style('fill', (d: any) =>
        d.data.kind === 'root' ? trunkColor
        : d.data.kind === 'level' ? (d.data.color ?? '#5d6cc0')
        : d.data.done ? '#3fb950'
        : d.data.kind === 'optional' ? '#6b7280' : '#8ab4ff');

    nodeEnter.append('text')
      .attr('dy', '0.32em')
      .attr('class', (d: any) =>
        `rl rl-${Math.min(d.depth, 3)}${d.data.kind === 'topic' && d.data.done ? ' rl-done' : ''}`)
      .attr('x', (d: any) => (d.data.kind === 'root' ? -14 : 12))
      .attr('text-anchor', (d: any) => (d.data.kind === 'root' ? 'end' : 'start'))
      .text((d: any) => d.data.name);

    nodeEnter.merge(node).transition().duration(t)
      .attr('transform', pos).attr('opacity', 1);
    node.exit().transition().duration(t)
      .attr('transform', pos(source)).attr('opacity', 0).remove();
  }

  function clickNode(d: any) {
    if (d.data.kind === 'topic' || d.data.kind === 'optional') { openDrawer(d.data); return; }
    if (d.children) { d._children = d.children; d.children = null; }
    else if (d._children) { d.children = d._children; d._children = null; }
    update(d);
  }

  function openDrawer(data: any) {
    drawerOpen = true;
    dLabel = data.label ?? data.name;
    dKind = data.kind === 'optional' ? 'related field' : 'topic';
    dLevel = data.level ?? 0;
    dDesc = data.desc ?? null;
    dWiki = data.wiki ?? null;
    dDone = data.kind !== 'optional' && done.has(data.id);
    dExtract = null;
    dExtractState = 'idle';

    // W-answers from the atlas structure behind this roadmap
    const idx = idToIdx.get(data.id);
    if (idx != null) {
      const n = sNodes[idx];
      dSize = n.size ?? 1;
      const chain: string[] = [];
      let p = sParents[idx];
      let guard = 0;
      while (p >= 0 && guard++ < 6) {
        chain.unshift(sNodes[p].name);
        p = sParents[p];
      }
      dPath = chain.join(' · ');
      dChildren = (sKids[idx] ?? [])
        .slice().sort((a, b) => (sNodes[b].size ?? 0) - (sNodes[a].size ?? 0))
        .slice(0, 5).map(i => sNodes[i].name);
      const rel: string[] = [];
      for (const [a, b] of xlinks) {
        if (rel.length >= 4) break;
        if (a === idx) rel.push(sNodes[b]?.name);
        else if (b === idx) rel.push(sNodes[a]?.name);
      }
      dRelated = rel.filter(Boolean);
    } else {
      dSize = 0; dPath = ''; dChildren = []; dRelated = [];
    }

    // live Wikipedia summary, behind the atlas description
    if (dWiki) {
      dExtractState = 'loading';
      fetchExtract(dWiki).then(ex => {
        // the drawer may have moved on while we waited
        if (dWiki === data.wiki && drawerOpen) {
          dExtract = ex;
          dExtractState = ex ? 'ok' : 'none';
        }
      });
    }
  }

  function toggleDone() {
    if (!roadmap || !dLabel) return;
    const node = roadmap.nodes.find(n => n.label === dLabel && n.kind === 'primary');
    if (!node) return;
    const next = new Set(done);
    if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
    done = next;
    try { localStorage.setItem(storageKey(slug), JSON.stringify([...next])); } catch { /* session-only */ }
    // refresh tree + drawer state
    root.each((d: any) => { if (d.data.kind === 'topic') d.data.done = done.has(d.data.id); });
    update(root);
    doneCount = roadmap.nodes.filter(n => n.kind === 'primary' && done.has(n.id)).length;
    dDone = done.has(node.id);
  }

  function resetProgress() {
    if (!roadmap) return;
    done = new Set();
    try { localStorage.removeItem(storageKey(slug)); } catch { /* ignore */ }
    root.each((d: any) => { if (d.data.kind === 'topic') d.data.done = false; });
    update(root);
    doneCount = 0;
    dDone = false;
  }

  function fit() {
    requestAnimationFrame(() => {
      try {
        const bounds = g.node().getBBox();
        if (!bounds.width || !bounds.height) return;
        const pad = 120;
        const sx = Math.min(width / (bounds.width + pad * 2), height / (bounds.height + pad * 2), 1.4);
        const tx = width / 2 - sx * (bounds.x + bounds.width / 2) + 40;
        const ty = height / 2 - sx * (bounds.y + bounds.height / 2);
        svg.transition().duration(450)
          .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(sx));
      } catch { /* not ready */ }
    });
  }

  function collapseAll() {
    root.descendants().forEach((d: any) => {
      if (d.depth >= 1 && d.children) { d._children = d.children; d.children = null; }
    });
    update(root);
    setTimeout(fit, 300);
  }

  /** darken the trunk colour a little per level so branches read as a sequence */
  function shade(hex: string, step: number) {
    const m = hex.replace('#', '');
    const num = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
    const f = 1 - Math.min(0.45, step * 0.13);
    const r = Math.round(((num >> 16) & 255) * f);
    const g2 = Math.round(((num >> 8) & 255) * f);
    const b = Math.round((num & 255) * f);
    return `#${((r << 16) | (g2 << 8) | b).toString(16).padStart(6, '0')}`;
  }

  onMount(async () => {
    const parts = location.pathname.split('/').filter(Boolean);
    // ['library','roadmap','physics'] on Pages, ['roadmap','physics'] locally
    slug = (parts[0] === 'library' ? parts[2] : parts[1]) ?? '';
    try {
      done = new Set(JSON.parse(localStorage.getItem(storageKey(slug)) ?? '[]'));
    } catch { done = new Set(); }

    try {
      const [rRes, sRes] = await Promise.all([
        fetch(`${BASE}data/artifacts/roadmaps.json`),
        fetch(`${BASE}data/artifacts/structure.json`),
      ]);
      if (!rRes.ok || !sRes.ok) throw new Error('artifact fetch failed');
      const r = await rRes.json();
      const s = await sRes.json();
      const rm = (r.roadmaps as Roadmap[]).find(x => x.slug === slug);
      if (!rm) throw new Error(`no roadmap for “${slug}”`);
      roadmap = rm;

      const meta = s.nodes[rm.node];
      title = meta?.name ?? slug;
      desc = meta?.description ?? '';
      trunkName = s.trunks[meta?.trunk]?.name ?? '';
      trunkColor = s.trunks[meta?.trunk]?.color ?? '#c9a227';

      // build the dendrogram: root → level branches → topics
      const byLevel = new Map<number, any[]>();
      for (const n of rm.nodes) {
        if (n.kind !== 'primary') continue;
        if (!byLevel.has(n.level)) byLevel.set(n.level, []);
        byLevel.get(n.level)!.push({
          name: n.label, kind: 'topic', id: n.id, level: n.level,
          desc: n.desc, wiki: n.wiki, size: n.size,
          done: done.has(n.id),
        });
      }
      const branches = [...byLevel.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([lv, topics]) => ({
          name: LEVELS[lv] ?? `Level ${lv + 1}`,
          kind: 'level', level: lv,
          color: shade(trunkColor, lv),
          children: topics,
        }));
      const optional = rm.nodes.filter(n => n.kind === 'optional');
      if (optional.length) {
        branches.push({
          name: 'Related fields', kind: 'level', level: branches.length,
          color: '#6b7280',
          children: optional.map(n => ({
            name: n.label, kind: 'optional', id: n.id, level: n.level,
            desc: n.desc, wiki: n.wiki, size: n.size, done: false,
          })),
        });
      }

      // atlas lookups for the drawer's W-answers
      sNodes = s.nodes;
      idToIdx = new Map(s.nodes.map((n: any, i: number) => [n.id, i]));
      sParents = s.nodes.map((n: any) => n.parent);
      sKids = Array.from({ length: s.nodes.length }, () => [] as number[]);
      for (let i = 0; i < s.nodes.length; i++) {
        const p = sParents[i];
        if (p >= 0) sKids[p].push(i);
      }
      xlinks = s.xlinks;

      dLevelNames = [...byLevel.keys()].sort((a, b) => a - b)
        .map(lv => LEVELS[lv] ?? `Level ${lv + 1}`);

      total = rm.nodes.filter(n => n.kind === 'primary').length;
      doneCount = rm.nodes.filter(n => n.kind === 'primary' && done.has(n.id)).length;

      root = d3.hierarchy({
        name: title, kind: 'root', children: branches,
        desc, wiki: meta?.wiki ?? null,
      });
      root.x0 = 0; root.y0 = 0;
      root.each((d: any) => { d.id = 't' + (idSeq++); });

      // The stage div only exists once `status` flips to ready.
      status = 'ready';
      await new Promise(r2 => requestAnimationFrame(r2));
      stage = document.getElementById('rstage')!;
      if (!stage) throw new Error('stage missing');
      width = stage.clientWidth || window.innerWidth;
      height = stage.clientHeight || window.innerHeight;

      svg = d3.select(stage).append('svg')
        .attr('viewBox', [0, 0, width, height])
        .attr('width', '100%').attr('height', height);
      g = svg.append('g');
      gLink = g.append('g');
      gNode = g.append('g');
      zoomBehavior = d3.zoom().scaleExtent([0.15, 4])
        .on('zoom', (event: any) => g.attr('transform', event.transform));
      svg.call(zoomBehavior);

      update(root, true);
      fit();
      setTimeout(fit, 150);

      const ro = new ResizeObserver(() => {
        const w = stage.clientWidth, h2 = stage.clientHeight;
        if (w && h2 && (w !== width || h2 !== height)) {
          width = w; height = h2;
          svg.attr('viewBox', [0, 0, width, height]).attr('height', height);
          fit();
        }
      });
      ro.observe(stage);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });
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
  {:else}
    <div id="rstage" class="stage" role="img" aria-label="Learning roadmap for {title}"></div>

    <div class="floats">
      <div class="panel title-panel">
        <p class="crumb">
          <a href={`${BASE}roadmap`}>← All roadmaps</a>{#if trunkName}<span class="sep">·</span><span style={`color:${trunkColor}`}>{trunkName}</span>{/if}
        </p>
        <h1 class="rm-title">{title}</h1>
        {#if desc}
          <p class="rm-desc">{desc}</p>
        {/if}
        <div class="progress">
          <div class="bar"><div class="fill" style={`width:${total ? Math.round(100 * doneCount / total) : 0}%;background:${trunkColor}`}></div></div>
          <span class="num">{doneCount}/{total} done</span>
        </div>
      </div>
      <div class="panel tools">
        <button type="button" onclick={collapseAll}>Collapse</button>
        <button type="button" onclick={fit}>Fit</button>
        <button type="button" class="danger" onclick={resetProgress}>Reset</button>
      </div>
      <p class="hint">click a topic for notes · drag to pan · scroll to zoom</p>
    </div>

    <div class="backdrop" class:show={drawerOpen} onclick={() => (drawerOpen = false)}></div>
    <aside class="notes" class:open={drawerOpen} style={`--trunk:${trunkColor}`}>
      <button type="button" class="notes-close" onclick={() => (drawerOpen = false)} aria-label="Close notes">✕</button>
      <p class="notes-kicker">
        {dKind}{dKind === 'topic' ? ` · ${LEVELS[dLevel] ?? `Level ${dLevel + 1}`}` : ''}
      </p>
      <h2 class="notes-title">{dLabel}</h2>

      {#if dKind === 'topic'}
        <button type="button" class="done-toggle" class:primary={dDone} onclick={toggleDone}>
          {dDone ? '✓ Completed — undo?' : 'Mark as completed'}
        </button>
      {/if}

      <section>
        <h3>What it is</h3>
        {#if dDesc}<p>{dDesc}</p>{/if}
        {#if dExtractState === 'loading'}
          <p class="extract-loading">reading the article…</p>
        {:else if dExtract}
          <p class="extract">{dExtract.length > 520 ? dExtract.slice(0, 517) + '…' : dExtract}</p>
        {/if}
        {#if !dDesc && dExtractState !== 'ok'}
          <p class="extract-loading">a summary for this field is not on file yet — the Wikipedia link below has the full story.</p>
        {/if}
      </section>

      {#if dSize > 1 || dRelated.length}
        <section>
          <h3>Why it matters</h3>
          {#if dSize > 1}<p>{fmt(dSize)} fields in the atlas grow out of this one.</p>{/if}
          {#if dRelated.length}
            <p class="why-line">It is closely tied to:</p>
            <div class="chips">{#each dRelated as r (r)}<span class="chip">{r}</span>{/each}</div>
          {/if}
        </section>
      {/if}

      {#if dPath}
        <section>
          <h3>Where it fits</h3>
          <p class="path">{dPath}</p>
        </section>
      {/if}

      {#if dChildren.length}
        <section>
          <h3>Where it leads</h3>
          <div class="chips">{#each dChildren as c (c)}<span class="chip">{c}</span>{/each}</div>
        </section>
      {/if}

      {#if dKind === 'topic' && dLevelNames.length}
        <section>
          <h3>How you'll learn it</h3>
          <ol class="levels">
            {#each dLevelNames as ln, li (ln)}
              <li class:current={li === dLevel}>{ln}{li === dLevel ? ' — you are here' : ''}</li>
            {/each}
          </ol>
        </section>
      {/if}

      {#if dWiki}
        <section>
          <h3>Elsewhere</h3>
          <a class="wiki" href={`https://en.wikipedia.org/wiki/${dWiki}`} target="_blank" rel="noopener noreferrer">
            Read on Wikipedia ↗
          </a>
        </section>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .view {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at 28% 40%, #12151a 0%, #0b0d0c 70%);
  }

  .state { padding: 120px 0 0 90px; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }
  .state__hint a { color: var(--text-secondary); font-size: 12px; }

  .stage { position: absolute; inset: 0; cursor: grab; }
  .stage:active { cursor: grabbing; }

  :global(.rlink) { fill: none; stroke: #333b44; stroke-width: 1.15; }
  :global(.rnode) { cursor: pointer; }
  :global(.rnode text) { font-family: var(--font-body); fill: #c8ccd1; }
  :global(.rl) { font-size: 13px; }
  :global(.rl-0) { font-size: 16px; font-weight: 800; fill: #e8b76a; }
  :global(.rl-1) { font-size: 13.5px; font-weight: 700; fill: #e6e2d6; }
  :global(.rl-2) { font-size: 12.5px; }
  :global(.rl-done) { fill: #86d99a !important; }
  :global(.rc) { stroke: #0b0d0c; stroke-width: 1.5; }
  :global(.rc:hover) { filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.45)); }
  :global(.rc-done) { fill: #3fb950 !important; }

  .floats { position: absolute; inset: 0; pointer-events: none; z-index: 20; }
  .panel {
    pointer-events: auto;
    background: var(--glass); backdrop-filter: blur(10px);
    border: 1px solid var(--line); border-radius: 12px; padding: 12px 18px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }
  .title-panel { position: absolute; top: 14px; left: 72px; max-width: 460px; }
  .crumb { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
  .crumb a { color: var(--text-secondary); text-decoration: none; }
  .crumb a:hover { color: var(--text-primary); }
  .crumb .sep { margin: 0 7px; }
  .rm-title { font-family: var(--font-body); font-size: 22px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 4px; }
  .rm-desc { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; margin: 0 0 10px; }
  .progress { display: flex; align-items: center; gap: 10px; }
  .progress .bar {
    width: 150px; height: 6px; border-radius: 99px;
    background: var(--bg-tertiary); overflow: hidden; border: 1px solid var(--line);
  }
  .progress .fill { height: 100%; transition: width 0.3s; }
  .progress span { font-size: 11px; color: var(--text-muted); }

  .tools { position: absolute; top: 14px; right: 16px; display: flex; gap: 8px; }
  .tools button {
    background: transparent; border: 1px solid var(--line-light); border-radius: 999px;
    color: var(--text-secondary); font: inherit; font-size: 12.5px; font-weight: 600;
    padding: 6px 14px; cursor: pointer;
  }
  .tools button:hover { color: var(--text-primary); border-color: var(--text-secondary); }
  .tools .danger:hover { border-color: #f85149; color: #f85149; }

  .hint {
    position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
    color: var(--text-muted); font-size: 12px;
    background: rgba(13, 16, 15, 0.75); border: 1px solid var(--line);
    border-radius: 999px; padding: 4px 14px; pointer-events: none; white-space: nowrap;
  }

  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 90;
    opacity: 0; transition: opacity 0.18s; pointer-events: none;
  }
  .backdrop.show { opacity: 1; pointer-events: auto; }

  .notes {
    position: fixed; top: 0; left: 0; bottom: 0; width: min(430px, 92vw); z-index: 100;
    background: var(--bg-secondary); border-right: 1px solid var(--line-light);
    box-shadow: 18px 0 50px rgba(0, 0, 0, 0.5);
    transform: translateX(-103%); transition: transform 0.22s ease;
    overflow-y: auto; padding: 20px 22px 40px;
  }
  .notes.open { transform: translateX(0); }
  .notes-close {
    position: absolute; top: 14px; right: 14px; width: 32px; height: 32px;
    border-radius: 50%; border: 1px solid var(--line-light);
    background: transparent; color: var(--text-muted); cursor: pointer;
  }
  .notes-close:hover { color: var(--text-primary); border-color: var(--text-secondary); }
  .notes-kicker {
    font-family: var(--font-data); font-size: 10.5px; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--trunk); margin-bottom: 6px;
  }
  .notes-title { font-family: var(--font-display); font-size: 26px; margin-bottom: 12px; padding-right: 28px; }
  .done-toggle {
    display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
    border-radius: 999px; border: 1px solid var(--line-light);
    background: transparent; color: var(--text-primary); font: inherit;
    font-size: 13px; font-weight: 600; padding: 7px 15px; margin: 2px 0 14px;
  }
  .done-toggle:hover { border-color: var(--text-secondary); }
  .done-toggle.primary { background: #274d33; border-color: #3fb950; color: #86d99a; }
  .notes section { border-top: 1px solid var(--line); padding: 14px 0; }
  .notes section h3 {
    font-family: var(--font-data); font-size: 10.5px; text-transform: uppercase;
    letter-spacing: 0.12em; color: var(--text-muted); margin-bottom: 9px;
  }
  .notes p { color: #c8ccd1; font-size: 14px; line-height: 1.6; }
  .wiki { font-size: 13.5px; color: var(--text-secondary); text-decoration: none; }
  .wiki:hover { color: var(--trunk); }
  .extract { color: #b8bdb3; font-size: 13.5px; line-height: 1.65; margin-top: 8px; }
  .extract-loading { color: var(--text-muted); font-size: 12.5px; font-style: italic; }
  .why-line { margin-bottom: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 7px; }
  .chip {
    font-size: 11.5px; color: var(--text-secondary);
    border: 1px solid var(--line-light); border-radius: 999px;
    padding: 3px 11px;
  }
  .path { font-family: var(--font-data); font-size: 12px; color: var(--text-secondary); line-height: 1.8; }
  .levels { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .levels li {
    font-size: 13px; color: var(--text-secondary);
    display: flex; align-items: center; gap: 8px;
  }
  .levels li::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--line-light);
  }
  .levels li.current {
    color: var(--trunk); font-weight: 600;
  }
  .levels li.current::before { background: var(--trunk); box-shadow: 0 0 6px var(--trunk); }

  @media (max-width: 640px) {
    .title-panel { left: 64px; max-width: 68vw; }
    .tools { top: auto; bottom: 14px; right: 12px; }
    .hint { display: none; }
  }
</style>
