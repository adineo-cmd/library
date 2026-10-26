<script lang="ts">
  /**
   * One trunk's tree — the detail page behind the domains index.
   *
   * Reached by clicking a trunk card on /domains (or a trunk link from the
   * home fan / sidebar). Shows only this main domain: the trunk at the
   * left, its domains fanned out, subdomains and fields opening on click.
   * No notes drawer here — this section is for seeing a domain's shape;
   * notes and roadmaps live in the roadmap section.
   */
  import { onMount } from 'svelte';
  import * as d3 from 'd3';

  interface SNode {
    id: string; name: string; description: string | null; wiki: string | null;
    parent: number; depth: number; size: number; trunk: number; kind: string;
  }
  interface Trunk { id: string; name: string; color: string }
  interface TData { name: string; kind: string; node: number; color: string }

  const BASE = import.meta.env.BASE_URL;
  const CAP = 30; // children shown before the "+ N more" node

  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';

  let nodes: SNode[] = [];
  let trunks: Trunk[] = [];
  let kids: number[][] = [];

  let currentTrunk = -1;
  let tName = '';
  let tColor = '#c9a227';
  let tDomains = 0;
  let tFields = 0;

  // ---- d3 state ----
  let svg: any, g: any, gLink: any, gNode: any, zoomBehavior: any, root: any;
  let width = 1200, height = 800;
  let stage: HTMLElement;
  let idSeq = 0;
  let viewK = 1; // current zoom scale, for centring jumps

  const fmt = (n: number) => n.toLocaleString('en-US');

  // ---- lazy children -------------------------------------------------------
  const shown = new Map<number, number>(); // node idx -> children shown
  const kindRank = (k: string) =>
    k === 'domain' ? 0 : k === 'subdomain' ? 1 : k === 'field' ? 2 : 3;

  function childrenOf(idx: number): TData[] | undefined {
    const all = kids[idx] ?? [];
    if (!all.length) return undefined;
    // popular first (hand-ranked in scripts/popularity.mjs); the kind tier
    // only breaks ties so a trunk's domains still lead its branches
    const sorted = [...all].sort((a, b) =>
      (nodes[b].pop ?? 0) - (nodes[a].pop ?? 0)
      || kindRank(nodes[a].kind) - kindRank(nodes[b].kind)
      || nodes[b].size - nodes[a].size
      || nodes[a].name.localeCompare(nodes[b].name));
    const n = Math.min(sorted.length, shown.get(idx) ?? CAP);
    const out: TData[] = sorted.slice(0, n).map(i => ({
      name: nodes[i].name, kind: nodes[i].kind, node: i,
      color: trunks[nodes[i].trunk]?.color ?? '#9aa39c',
    }));
    if (sorted.length > n) {
      out.push({ name: `+ ${fmt(sorted.length - n)} more`, kind: 'more', node: idx, color: '#5c6660' });
    }
    return out;
  }

  /** Wrap one TData as a proper d3 hierarchy node — raw objects pushed into
   *  d.children crash every accessor that reads d.data. */
  function wrap(data: TData, parent: any): any {
    return { data, parent, depth: parent.depth + 1, id: 'h' + (idSeq++) };
  }
  function kidsAsNodes(idx: number, parent: any): any[] {
    return (childrenOf(idx) ?? []).map(c => wrap(c, parent));
  }

  // ---- d3 render -----------------------------------------------------------
  const pos = (d: any) => `translate(${d.y},${d.x})`;
  const diagonal = d3.linkHorizontal().x((d: any) => d.y).y((d: any) => d.x);

  function update(source: any, first = false) {
    d3.tree().nodeSize([30, 230])(root);
    const nodesNow = root.descendants();
    const links = root.links();
    const t = first ? 0 : 280;

    const link = gLink.selectAll('path.xlink').data(links, (d: any) => d.target.id);
    link.enter().append('path').attr('class', 'xlink')
      .merge(link).transition().duration(t).attr('d', diagonal);
    link.exit().transition().duration(t).attr('d', diagonal).remove();

    const node = gNode.selectAll('g.xnode').data(nodesNow, (d: any) => d.id);
    const nodeEnter = node.enter().append('g')
      .attr('class', 'xnode')
      .attr('transform', first ? pos : pos(source))
      .attr('opacity', first ? 1 : 0)
      .on('click', (event: any, d: any) => { event.stopPropagation(); clickNode(d); });

    nodeEnter.append('circle')
      .attr('r', (d: any) => d.data.kind === 'trunk' ? 9
        : d.data.kind === 'domain' ? 6
        : d.data.kind === 'subdomain' ? 5
        : d.data.kind === 'more' ? 4 : 3.5)
      .attr('class', (d: any) => `xc xc-${d.data.kind}`)
      .style('fill', (d: any) => d.data.color);

    nodeEnter.append('text')
      .attr('dy', '0.32em')
      .attr('class', (d: any) => `xl xl-${Math.min(d.depth, 4)}`)
      .attr('x', (d: any) => (d.data.kind === 'trunk' ? -16 : 12))
      .attr('text-anchor', (d: any) => (d.data.kind === 'trunk' ? 'end' : 'start'))
      .text((d: any) => d.data.name);

    nodeEnter.merge(node).transition().duration(t)
      .attr('transform', pos).attr('opacity', 1);
    node.exit().transition().duration(t)
      .attr('transform', pos(source)).attr('opacity', 0).remove();
  }

  function clickNode(d: any) {
    if (d.data.kind === 'more') {
      // widen the parent's window and re-render its children
      const idx = d.data.node;
      shown.set(idx, (shown.get(idx) ?? CAP) + CAP);
      const parent = d.parent;
      const next = kidsAsNodes(idx, parent);
      parent.children = next.length ? next : null;
      update(parent);
      return;
    }
    // browse-only: a click expands or collapses, nothing else
    if (d.children) { d._children = d.children; d.children = null; }
    else if (d._children) { d.children = d._children; d._children = null; }
    else {
      const next = kidsAsNodes(d.data.node, d);
      if (!next.length) return;
      d.children = next;
    }
    update(d);
  }

  function fit() {
    requestAnimationFrame(() => {
      try {
        const bounds = g.node().getBBox();
        if (!bounds.width || !bounds.height) return;
        const pad = 110;
        const sx = Math.min(width / (bounds.width + pad * 2), height / (bounds.height + pad * 2), 1.4);
        const tx = width / 2 - sx * (bounds.x + bounds.width / 2) + 40;
        const ty = height / 2 - sx * (bounds.y + bounds.height / 2);
        svg.transition().duration(450)
          .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(sx));
      } catch { /* bbox not ready */ }
    });
  }

  function expandAll() {
    let any = false;
    for (const d of root.descendants()) {
      if (d._children) { d.children = d._children; d._children = null; any = true; }
      else if (!d.children && d.data.kind !== 'field' && d.data.kind !== 'more') {
        const next = kidsAsNodes(d.data.node, d);
        if (next.length) { d.children = next; any = true; }
      }
    }
    if (any) { update(root); setTimeout(fit, 300); }
  }

  function collapseToDomains() {
    root.descendants().forEach((d: any) => {
      if (d.depth >= 2 && d.children) { d._children = d.children; d.children = null; }
    });
    update(root);
    setTimeout(fit, 300);
  }

  // ---- trunk switching -------------------------------------------------------
  function trunkNodeIdx(ti: number) {
    return nodes.findIndex(n => n.kind === 'trunk' && n.trunk === ti);
  }

  function setTrunk(ti: number, push = true) {
    if (ti < 0 || ti >= trunks.length || ti === currentTrunk) return;
    currentTrunk = ti;
    shown.clear();
    const t = trunks[ti];
    tName = t.name;
    tColor = t.color;
    const tIdx = trunkNodeIdx(ti);
    tDomains = (kids[tIdx] ?? []).length;
    tFields = nodes.reduce((s, n) => (n.trunk === ti && n.kind === 'field' ? s + 1 : s), 0);

    root = d3.hierarchy({ name: t.name, kind: 'trunk', node: tIdx, color: t.color });
    root.x0 = 0; root.y0 = 0;
    root.each((d: any) => { d.id = 'h' + (idSeq++); });
    // show the trunk's domains immediately — that is the point of the page
    const first = kidsAsNodes(tIdx, root);
    if (first.length) root.children = first;

    if (push) {
      history.replaceState(null, '', `${BASE}domains/${t.id}`);
    }
    update(root, true);
    setTimeout(fit, 60);
  }

  /** Deep link #n=<idx>: switch to that node's trunk, open the ancestor
   *  path, and centre the node on screen. */
  function focusNode(idx: number) {
    const n = nodes[idx];
    if (!n) return;
    setTrunk(n.trunk, false);
    // expand the ancestor chain inside the fresh tree
    let d: any = root;
    for (const ci of (() => {
      const chain: number[] = [];
      let cur = n.parent;
      let guard = 0;
      while (cur >= 0 && guard++ < 12) { chain.unshift(cur); cur = nodes[cur].parent; }
      return chain;
    })()) {
      if (ci === trunkNodeIdx(n.trunk)) continue;
      if (!d.children) {
        const next = kidsAsNodes(d.data.node, d);
        if (!next.length) break;
        d.children = next;
      }
      const hit = d.children.find((c: any) => c.data.node === ci || c.data.kind === 'more');
      if (!hit) break;
      d = hit;
      if (d.data.kind === 'more') {
        let guard2 = 0;
        while (d.data.kind === 'more' && guard2++ < 40) {
          const p = d.parent;
          shown.set(p.data.node, (shown.get(p.data.node) ?? CAP) + CAP);
          const next = kidsAsNodes(p.data.node, p);
          if (!next.length) break;
          p.children = next;
          const again = p.children.find((c: any) => c.data.node === ci);
          if (again) { d = again; break; }
          d = p.children.find((c: any) => c.data.kind === 'more');
          if (!d) { d = p; break; }
        }
      }
    }
    // the chain walk stops at the node's PARENT — open it one more level so
    // the target node itself is on screen
    if (d.data.node !== idx && !d.children) {
      const next = kidsAsNodes(d.data.node, d);
      if (next.length) d.children = next;
    }
    update(root);
    setTimeout(() => {
      try {
        const hit = root.descendants().find((x: any) => x.data.node === idx);
        if (!hit) { fit(); return; }
        const k = Math.max(viewK, 0.9);
        svg.transition().duration(600)
          .call(zoomBehavior.transform,
            d3.zoomIdentity.translate(width / 2 - k * hit.y - 60, height / 2 - k * hit.x).scale(k));
      } catch { fit(); }
    }, 380);
  }

  // ---- boot --------------------------------------------------------------------
  onMount(async () => {
    try {
      const res = await fetch(`${BASE}data/artifacts/structure.json`);
      if (!res.ok) throw new Error(`structure.json → ${res.status}`);
      const s = await res.json();
      nodes = s.nodes;
      trunks = s.trunks;
      kids = Array.from({ length: nodes.length }, () => [] as number[]);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].parent;
        if (p >= 0) kids[p].push(i);
      }

      status = 'ready';
      await new Promise(r => requestAnimationFrame(r));
      stage = document.getElementById('xstage')!;
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
        .on('zoom', (event: any) => {
          viewK = event.transform.k;
          g.attr('transform', event.transform);
        });
      svg.call(zoomBehavior);

      // entry trunk: the URL path names it (/domains/<id>); #n=<idx> from
      // sidebar search jumps deeper still
      const parts = location.pathname.split('/').filter(Boolean);
      const pathId = (parts[0] === 'memex' ? parts[2] : parts[1]) ?? '';
      const initial = trunks.findIndex(t => t.id === pathId);
      setTrunk(initial >= 0 ? initial : 0, false);
      const applyHash = () => {
        const h = decodeURIComponent(location.hash.slice(1));
        if (h.startsWith('n=')) {
          const idx = Number(h.slice(2));
          if (Number.isInteger(idx) && nodes[idx]) focusNode(idx);
        }
      };
      applyHash();
      window.addEventListener('hashchange', applyHash);

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

<div class="explorer">
  {#if status === 'loading'}
    <p class="state" role="status">Slicing the atlas…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The tree could not be drawn.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <div id="xstage" class="stage" role="img" aria-label="Tree of the {tName} domain"></div>

    <div class="floats">
      <div class="panel title-panel">
        <a class="crumb" href={`${BASE}domains`}>← All domains</a>
        <h1 class="sel-title" style={`color:${tColor}`}>{tName}</h1>
        <p class="sel-sub num">{tDomains} domains · {fmt(tFields)} fields — click a node to open its branches</p>
      </div>
      <div class="panel tools">
        <button type="button" onclick={expandAll}>Expand</button>
        <button type="button" onclick={collapseToDomains}>Collapse</button>
        <button type="button" onclick={fit}>Fit</button>
      </div>
      <p class="hint">click to expand · drag to pan · scroll to zoom</p>
    </div>
  {/if}
</div>

<style>
  .explorer {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at 28% 40%, #12151a 0%, #0b0d0c 70%);
  }

  .state { padding: 120px 0 0 90px; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }

  .stage { position: absolute; inset: 0; cursor: grab; }
  .stage:active { cursor: grabbing; }

  :global(.xlink) { fill: none; stroke: #333b44; stroke-width: 1.15; }
  :global(.xnode) { cursor: pointer; }
  :global(.xnode text) { font-family: var(--font-body); fill: #c8ccd1; }
  :global(.xl) { font-size: 13px; }
  :global(.xl-0) { font-size: 17px; font-weight: 800; fill: #e8b76a; }
  :global(.xl-1) { font-size: 14px; font-weight: 700; fill: #e6e2d6; }
  :global(.xl-2) { font-size: 12.5px; }
  :global(.xl-3), :global(.xl-4) { font-size: 11.5px; fill: #9aa39c; }
  :global(.xc) { stroke: #0b0d0c; stroke-width: 1.5; }
  :global(.xc:hover) { filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.45)); }
  :global(.xc-more) { fill: #5c6660 !important; stroke-dasharray: 2 2; }

  .floats { position: absolute; inset: 0; pointer-events: none; z-index: 20; }
  .panel {
    pointer-events: auto;
    background: var(--glass); backdrop-filter: blur(10px);
    border: 1px solid var(--line); border-radius: 12px; padding: 10px 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }

  .crumb { font-size: 12px; color: var(--text-secondary); text-decoration: none; }
  .crumb:hover { color: var(--text-primary); }

  .title-panel { position: absolute; top: 14px; left: 72px; max-width: 420px; }
  .sel-title { font-family: var(--font-body); font-size: 22px; font-weight: 700; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sel-sub { font-size: 11.5px; color: var(--text-muted); }

  .tools { position: absolute; top: 14px; right: 16px; display: flex; gap: 8px; }
  .tools button {
    background: transparent; border: 1px solid var(--line-light); border-radius: 999px;
    color: var(--text-secondary); font: inherit; font-size: 12.5px; font-weight: 600;
    padding: 6px 14px; cursor: pointer;
  }
  .tools button:hover { color: var(--text-primary); border-color: var(--text-secondary); }

  .hint {
    position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
    color: var(--text-muted); font-size: 12px;
    background: rgba(13, 16, 15, 0.75); border: 1px solid var(--line);
    border-radius: 999px; padding: 4px 14px; pointer-events: none; white-space: nowrap;
  }

  @media (max-width: 720px) {
    .title-panel { left: 64px; max-width: 62vw; }
    .tools { top: auto; bottom: 14px; right: 12px; }
    .hint { display: none; }
  }
</style>
