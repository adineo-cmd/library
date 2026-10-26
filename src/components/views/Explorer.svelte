<script lang="ts">
  /**
   * The domains view — the whole atlas as one horizontal dendrogram.
   *
   * The CareerMap Explorer pattern, rebuilt on the Arbor data: a D3
   * left-to-right tree whose root fans into the eight trunks, every branch
   * collapsible, every section stacked vertically at its own depth. Clicking
   * a branch toggles it and opens its notes; clicking a leaf opens the notes
   * drawer that slides in from the LEFT. Oversized buckets reveal themselves
   * in batches through a "+ N more" node rather than dumping hundreds of
   * rows into the layout at once.
   */
  import { onMount } from 'svelte';
  import * as d3 from 'd3';

  interface SNode {
    id: string; name: string; description: string | null; wiki: string | null;
    parent: number; depth: number; size: number; trunk: number; kind: string;
  }
  interface Trunk { id: string; name: string; color: string }

  const BASE = import.meta.env.BASE_URL;
  const CAP = 28;               // children shown before the "+ N more" node
  const LEVEL_NAMES = ['Foundations', 'Core', 'Advanced', 'Specialisations', 'Frontiers', 'Further'];

  interface RoadmapNode {
    id: string; label: string; level: number; kind: 'primary' | 'optional';
    desc: string | null; wiki: string | null; size: number;
  }
  interface Roadmap {
    slug: string; node: number; levelCount: number;
    nodes: RoadmapNode[]; edges: [number, number][];
  }
  const LEVELS = ['Foundations', 'Core', 'Advanced', 'Specialisations', 'Frontiers', 'Further'];

  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';

  let nodes: SNode[] = [];
  let trunks: Trunk[] = [];
  let kids: number[][] = [];
  let relatedOf: number[][] = [];
  let roadmapLinks: Record<string, string> = {};

  let selectedIdx = -1;
  let selTitle = 'Atlas';
  let selSub = 'Pick a branch';

  let drawerNode = -1;
  let drawerOpen = false;

  // ---------- sliced-in roadmap ----------
  // Clicking a domain/subdomain/field that has a roadmap opens that roadmap
  // IN PLACE — the same dendrogram the roadmap section draws — instead of
  // navigating away. Trunks keep the explorer behaviour: they are navigation.
  let roadmapByNode = new Map<number, Roadmap>();
  let roadmapsLoaded = false;
  let slice: Roadmap | null = null;
  let sliceTitle = '';
  let sliceColor = '#c9a227';
  let sliceParent = '';
  let sliceDone: Set<string> = new Set();
  let sliceDoneCount = 0;
  let sliceTotal = 0;
  // slice drawer
  let sDrawerOpen = false;
  let sdLabel = '';
  let sdKind: string = 'topic';
  let sdLevel = 0;
  let sdDesc: string | null = null;
  let sdWiki: string | null = null;
  let sdDone = false;
  let sdId = '';
  // slice d3 instances (separate from the atlas tree's)
  let sSvg: any, sG: any, sGLink: any, sGNode: any, sZoom: any, sRoot: any;
  let sW = 1200, sH = 800;
  let sIdSeq = 0;

  // -- notes drawer content (kept flat so the markup stays simple) --------
  let dName = '';
  let dKind = '';
  let dTrunk = '';
  let dColor = '#c9a227';
  let dDesc: string | null = null;
  let dWiki: string | null = null;
  let dRelated: { name: string; idx: number }[] = [];
  let dChildren: { name: string; idx: number }[] = [];
  let dRoadmap: string | null = null;
  let dSize = 0;

  const fmt = (n: number) => n.toLocaleString('en-US');

  // -- hierarchy -----------------------------------------------------------
  const shown = new Map<number, number>();   // node idx -> children shown
  const kindRank = (k: string) =>
    k === 'domain' ? 0 : k === 'subdomain' ? 1 : k === 'field' ? 2 : 3;

  function childrenOf(idx: number): TData[] | undefined {
    const all = kids[idx] ?? [];
    if (!all.length) return undefined;
    const sorted = [...all].sort((a, b) =>
      kindRank(nodes[a].kind) - kindRank(nodes[b].kind)
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

  interface TData { name: string; kind: string; node: number; color: string }

  // -- D3 globals (bound in onMount) ----------------------------------------
  let svg: any, g: any, gLink: any, gNode: any, zoomBehavior: any;
  let root: any;
  let width = 1200, height = 800;
  let stage: HTMLElement;
  let idSeq = 0;

  const pos = (d: any) => `translate(${d.y},${d.x})`;
  const treeLayout = () => d3.tree().nodeSize([27, 210]);
  const diagonal = d3.linkHorizontal().x((d: any) => d.y).y((d: any) => d.x);

  /**
   * Wrap one TData into a proper D3 hierarchy node. Children are attached
   * lazily by clickNode — a raw object pushed straight into d.children would
   * render without .data and crash the accessor functions.
   */
  function wrap(data: TData, parent: any, depth: number): any {
    return { data, parent, depth, id: 'h' + (idSeq++) };
  }

  function kidsAsNodes(idx: number, parent: any): any[] {
    return (childrenOf(idx) ?? []).map(c => wrap(c, parent, parent.depth + 1));
  }

  function update(source: any, first = false) {
    treeLayout()(root);
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
      .attr('r', (d: any) => d.data.kind === 'root' ? 9 : d.data.kind === 'trunk' ? 6.5
        : d.data.kind === 'more' ? 4 : d.data.kind === 'domain' ? 5.5 : d.data.kind === 'subdomain' ? 4.5 : 3.5)
      .attr('class', (d: any) => `xc xc-${d.data.kind}${d.data.kind === 'field' ? ' xc-leaf' : ''}`)
      .style('fill', (d: any) => d.data.kind === 'root' ? '#e8b76a' : d.data.color);

    nodeEnter.append('text')
      .attr('dy', '0.32em')
      .attr('class', (d: any) => `xl xl-${Math.min(d.depth, 4)}`)
      .attr('x', (d: any) => (d.data.kind === 'root' ? -14 : 11))
      .attr('text-anchor', (d: any) => (d.data.kind === 'root' ? 'end' : 'start'))
      .text((d: any) => d.data.name);

    nodeEnter.merge(node).transition().duration(t)
      .attr('transform', pos).attr('opacity', 1);
    node.exit().transition().duration(t)
      .attr('transform', pos(source)).attr('opacity', 0).remove();

    nodesNow.forEach((d: any) => { d.x0 = d.x; d.y0 = d.y; });
  }

  async function ensureRoadmaps() {
    if (roadmapsLoaded) return;
    try {
      const res = await fetch(`${BASE}data/artifacts/roadmaps.json`);
      if (res.ok) {
        const r = await res.json();
        for (const rm of r.roadmaps as Roadmap[]) roadmapByNode.set(rm.node, rm);
      }
    } catch { /* roadmap slicing stays off if the artifact is missing */ }
    roadmapsLoaded = true;
  }

  function clickNode(d: any) {
    const kind = d.data.kind;
    if (kind === 'more') {
      const idx = d.data.node;
      shown.set(idx, (shown.get(idx) ?? CAP) + CAP);
      const parent = d.parent;
      const next = kidsAsNodes(idx, parent);
      parent.children = next.length ? next : null;
      update(parent);
      return;
    }
    if (kind === 'root') return;

    // Expand/collapse first, then decide about panels: an OPENING gesture
    // (the branch was closed) slices in the roadmap or opens notes; a
    // CLOSING gesture must not churn panels back open.
    const wasExpanded = !!d.children;
    if (d.children) { d._children = d.children; d.children = null; update(d); }
    else if (d._children) { d.children = d._children; d._children = null; update(d); }
    else {
      const next = kidsAsNodes(d.data.node, d);
      if (next.length) {
        d.children = next;
        update(d);
        setTimeout(fit, 320);
      }
    }
    if (wasExpanded) return;

    // opening: slice in the roadmap, or fall back to the notes drawer.
    // Trunks are navigation, so they always take notes.
    const idx = d.data.node;
    if (kind !== 'trunk' && roadmapByNode.has(idx)) {
      openSlice(idx);
    } else if (roadmapsLoaded) {
      openNotes(idx);
    } else {
      openNotes(idx);
      ensureRoadmaps().then(() => {
        if (!slice && roadmapByNode.has(idx)) openSlice(idx);
      });
    }
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

  function expandOneLevel() {
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

  function collapseAll() {
    root.descendants().forEach((d: any) => {
      if (d.depth >= 2 && d.children) { d._children = d.children; d.children = null; }
    });
    update(root);
    setTimeout(fit, 300);
  }

  // -- notes drawer ----------------------------------------------------------
  function openNotes(idx: number) {
    const n = nodes[idx];
    if (!n) return;
    selectedIdx = idx;
    drawerNode = idx;
    drawerOpen = true;
    dName = n.name;
    dKind = n.kind;
    dTrunk = trunks[n.trunk]?.name ?? '';
    dColor = trunks[n.trunk]?.color ?? '#c9a227';
    dDesc = n.description;
    dWiki = n.wiki;
    dSize = n.size;
    dRoadmap = roadmapLinks[String(idx)] ?? null;
    dRelated = (relatedOf[idx] ?? [])
      .filter(r => nodes[r])
      .sort((a, b) => nodes[b].size - nodes[a].size)
      .slice(0, 6)
      .map(r => ({ name: nodes[r].name, idx: r }));
    dChildren = (kids[idx] ?? [])
      .sort((a, b) => nodes[b].size - nodes[a].size)
      .slice(0, 8)
      .map(c => ({ name: nodes[c].name, idx: c }));
    selTitle = n.name;
    selSub = `${dKind} · ${dTrunk}${n.parent >= 0 ? ` · under ${nodes[n.parent].name}` : ''}`;
  }

  function closeNotes() { drawerOpen = false; }

  function focusNode(idx: number) {
    // expand the ancestor chain, then open notes
    const chain: number[] = [];
    let cur = nodes[idx].parent;
    let guard = 0;
    while (cur >= 0 && guard++ < 12) { chain.unshift(cur); cur = nodes[cur].parent; }
    // walk the d3 tree following chain of node indices
    let d = root;
    for (const ci of chain) {
      if (!d.children) {
        const next = kidsAsNodes(d.data.node, d);
        if (!next.length) break;
        d.children = next;
      }
      const hit = d.children.find((c: any) => c.data.node === ci || c.data.kind === 'more');
      if (!hit) break;
      d = hit;
      if (d.data.kind === 'more') {
        // keep widening until the wanted child is in view
        let guard2 = 0;
        while (d.data.kind === 'more' && guard2++ < 30) {
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
    update(root);
    setTimeout(fit, 340);
    // same rule as a click: a topic with a roadmap slices it in
    if (nodes[idx].kind !== 'trunk' && roadmapByNode.has(idx)) openSlice(idx);
    else openNotes(idx);
  }

  // ---------- sliced-in roadmap tree ----------
  const sPos = (d: any) => `translate(${d.y},${d.x})`;
  const sDiagonal = d3.linkHorizontal().x((d: any) => d.y).y((d: any) => d.x);

  function shade(hex: string, step: number) {
    const m = hex.replace('#', '');
    const num = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
    const f = 1 - Math.min(0.45, step * 0.13);
    const r = Math.round(((num >> 16) & 255) * f);
    const g2 = Math.round(((num >> 8) & 255) * f);
    const b = Math.round((num & 255) * f);
    return `#${((r << 16) | (g2 << 8) | b).toString(16).padStart(6, '0')}`;
  }

  function openSlice(idx: number) {
    const rm = roadmapByNode.get(idx);
    if (!rm) { openNotes(idx); return; }
    try {
      sliceDone = new Set(JSON.parse(localStorage.getItem('arbor-roadmap-' + rm.slug) ?? '[]'));
    } catch { sliceDone = new Set(); }
    sliceDoneCount = rm.nodes.filter(n => n.kind === 'primary' && sliceDone.has(n.id)).length;
    sliceTotal = rm.nodes.filter(n => n.kind === 'primary').length;
    sliceTitle = nodes[idx].name;
    sliceColor = trunks[nodes[idx].trunk]?.color ?? '#c9a227';
    sliceParent = nodes[idx].parent >= 0 ? nodes[nodes[idx].parent].name : '';
    drawerOpen = false;
    sDrawerOpen = false;
    slice = rm;
    // the stage div needs one frame to exist
    requestAnimationFrame(() => buildSliceTree(rm));
  }

  function buildSliceTree(rm: Roadmap) {
    const stage = document.getElementById('sliceStage');
    if (!stage) return;
    stage.innerHTML = '';
    sW = stage.clientWidth || window.innerWidth;
    sH = stage.clientHeight || window.innerHeight;
    sSvg = d3.select(stage).append('svg')
      .attr('viewBox', [0, 0, sW, sH])
      .attr('width', '100%').attr('height', sH);
    sG = sSvg.append('g');
    sGLink = sG.append('g');
    sGNode = sG.append('g');
    sZoom = d3.zoom().scaleExtent([0.15, 4])
      .on('zoom', (event: any) => sG.attr('transform', event.transform));
    sSvg.call(sZoom);

    const byLevel = new Map<number, any[]>();
    for (const n of rm.nodes) {
      if (n.kind !== 'primary') continue;
      if (!byLevel.has(n.level)) byLevel.set(n.level, []);
      byLevel.get(n.level)!.push({
        name: n.label, kind: 'topic', id: n.id, level: n.level,
        desc: n.desc, wiki: n.wiki, size: n.size,
        done: sliceDone.has(n.id),
      });
    }
    const branches = [...byLevel.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([lv, topics]) => ({
        name: LEVEL_NAMES[lv] ?? `Level ${lv + 1}`,
        kind: 'level', level: lv, color: shade(sliceColor, lv),
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
    sRoot = d3.hierarchy({ name: sliceTitle, kind: 'root', children: branches });
    sRoot.x0 = 0; sRoot.y0 = 0;
    sRoot.each((d: any) => { d.id = 's' + (sIdSeq++); });
    sUpdate(sRoot, true);
    sFit();
    setTimeout(sFit, 150);
  }

  function sUpdate(source: any, first = false) {
    d3.tree().nodeSize([30, 220])(sRoot);
    const nodesNow = sRoot.descendants();
    const links = sRoot.links();
    const t = first ? 0 : 280;

    const link = sGLink.selectAll('path.slink').data(links, (d: any) => d.target.id);
    link.enter().append('path').attr('class', 'slink')
      .merge(link).transition().duration(t).attr('d', sDiagonal);
    link.exit().transition().duration(t).attr('d', sDiagonal).remove();

    const node = sGNode.selectAll('g.snode').data(nodesNow, (d: any) => d.id);
    const nodeEnter = node.enter().append('g')
      .attr('class', 'snode')
      .attr('transform', first ? sPos : sPos(source))
      .attr('opacity', first ? 1 : 0)
      .on('click', (event: any, d: any) => { event.stopPropagation(); sClick(d); });

    nodeEnter.append('circle')
      .attr('r', (d: any) => d.data.kind === 'root' ? 10 : d.data.kind === 'level' ? 7 : 5)
      .attr('class', (d: any) =>
        `sc sc-${d.data.kind}${d.data.kind === 'topic' && d.data.done ? ' sc-done' : ''}`)
      .style('fill', (d: any) =>
        d.data.kind === 'root' ? sliceColor
        : d.data.kind === 'level' ? (d.data.color ?? '#5d6cc0')
        : d.data.done ? '#3fb950'
        : d.data.kind === 'optional' ? '#6b7280' : '#8ab4ff');

    nodeEnter.append('text')
      .attr('dy', '0.32em')
      .attr('class', (d: any) =>
        `sl sl-${Math.min(d.depth, 3)}${d.data.kind === 'topic' && d.data.done ? ' sl-done' : ''}`)
      .attr('x', (d: any) => (d.data.kind === 'root' ? -14 : 12))
      .attr('text-anchor', (d: any) => (d.data.kind === 'root' ? 'end' : 'start'))
      .text((d: any) => d.data.name);

    nodeEnter.merge(node).transition().duration(t)
      .attr('transform', sPos).attr('opacity', 1);
    node.exit().transition().duration(t)
      .attr('transform', sPos(source)).attr('opacity', 0).remove();
  }

  function sClick(d: any) {
    if (d.data.kind === 'topic' || d.data.kind === 'optional') {
      sdLabel = d.data.name;
      sdKind = d.data.kind;
      sdLevel = d.data.level ?? 0;
      sdDesc = d.data.desc ?? null;
      sdWiki = d.data.wiki ?? null;
      sdDone = d.data.kind !== 'optional' && sliceDone.has(d.data.id);
      sdId = d.data.id;
      sDrawerOpen = true;
      return;
    }
    if (d.children) { d._children = d.children; d.children = null; }
    else if (d._children) { d.children = d._children; d._children = null; }
    sUpdate(d);
  }

  function toggleSdDone() {
    if (!slice) return;
    const node = slice.nodes.find(n => n.id === sdId && n.kind === 'primary');
    if (!node) return;
    const next = new Set(sliceDone);
    if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
    sliceDone = next;
    try { localStorage.setItem('arbor-roadmap-' + slice.slug, JSON.stringify([...next])); } catch { /* session-only */ }
    sRoot.each((d: any) => { if (d.data.kind === 'topic') d.data.done = sliceDone.has(d.data.id); });
    sUpdate(sRoot);
    sliceDoneCount = slice.nodes.filter(n => n.kind === 'primary' && sliceDone.has(n.id)).length;
    sdDone = sliceDone.has(node.id);
  }

  function sFit() {
    requestAnimationFrame(() => {
      try {
        const bounds = sG.node().getBBox();
        if (!bounds.width || !bounds.height) return;
        const pad = 120;
        const sx = Math.min(sW / (bounds.width + pad * 2), sH / (bounds.height + pad * 2), 1.4);
        const tx = sW / 2 - sx * (bounds.x + bounds.width / 2) + 40;
        const ty = sH / 2 - sx * (bounds.y + bounds.height / 2);
        sSvg.transition().duration(450)
          .call(sZoom.transform, d3.zoomIdentity.translate(tx, ty).scale(sx));
      } catch { /* not ready */ }
    });
  }

  function closeSlice() {
    slice = null;
    sDrawerOpen = false;
  }

  // -- boot --------------------------------------------------------------------
  onMount(async () => {
    try {
      const [sRes, lRes] = await Promise.all([
        fetch(`${BASE}data/artifacts/structure.json`),
        fetch(`${BASE}data/artifacts/roadmap-links.json`),
      ]);
      if (!sRes.ok) throw new Error(`structure.json → ${sRes.status}`);
      const s = await sRes.json();
      nodes = s.nodes;
      trunks = s.trunks;
      kids = Array.from({ length: nodes.length }, () => [] as number[]);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].parent;
        if (p >= 0) kids[p].push(i);
      }
      relatedOf = Array.from({ length: nodes.length }, () => [] as number[]);
      for (const [a, b] of s.xlinks as [number, number][]) {
        relatedOf[a]?.push(b);
        relatedOf[b]?.push(a);
      }
      roadmapLinks = lRes.ok ? await lRes.json() : {};
      ensureRoadmaps(); // warm the slice index so first clicks are instant

      const rootTrunks = nodes
        .map((n, i) => ({ n, i }))
        .filter(x => x.n.kind === 'trunk')
        .sort((a, b) => kids[b.i].length - kids[a.i].length)
        .map(x => ({
          name: x.n.name, kind: 'trunk', node: x.i,
          color: trunks[x.n.trunk]?.color ?? '#9aa39c',
        }));
      root = d3.hierarchy({ name: 'Atlas', kind: 'root', node: -1, color: '#e8b76a', children: rootTrunks });
      root.x0 = 0; root.y0 = 0;
      root.each((d: any) => { d.id = 'h' + (idSeq++); });
      // start with trunks expanded to their domains
      root.children.forEach((d: any) => {
        const next = kidsAsNodes(d.data.node, d);
        if (next.length) d.children = next;
      });

      // The stage div only exists once `status` flips to ready — building the
      // SVG before that rendered nothing and threw on clientWidth.
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
        .on('zoom', (event: any) => g.attr('transform', event.transform));
      svg.call(zoomBehavior);

      update(root, true);
      fit();
      setTimeout(fit, 150);

      // deep links: #n=<index>, or a trunk id (#sciences)
      const applyHash = () => {
        const h = decodeURIComponent(location.hash.slice(1));
        if (!h) return;
        if (h.startsWith('n=')) {
          const idx = Number(h.slice(2));
          if (Number.isInteger(idx) && nodes[idx]) focusNode(idx);
          // focusNode routes to the roadmap slice or notes on its own
        } else {
          const ti = trunks.findIndex(t => t.id === h);
          if (ti >= 0) {
            const trunkNode = nodes.findIndex(n => n.kind === 'trunk' && n.trunk === ti);
            if (trunkNode >= 0) { focusNode(trunkNode); openNotes(trunkNode); }
          }
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
    <p class="state" role="status">Growing the tree…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The tree could not be drawn.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <div id="xstage" class="stage" role="img" aria-label="Tree of all domains and fields"></div>

    <div class="floats">
      <div class="panel title-panel">
        <p class="crumb">Explorer · {fmt(nodes.length)} nodes</p>
        <h1 class="sel-title" style={`color:${dColor}`}>{selTitle}</h1>
        <p class="sel-sub">{selSub}</p>
      </div>
      <div class="panel tools">
        <button type="button" onclick={expandOneLevel}>Expand</button>
        <button type="button" onclick={collapseAll}>Collapse</button>
        <button type="button" onclick={fit}>Fit</button>
      </div>
      <p class="hint">click a node for notes · drag to pan · scroll to zoom</p>
    </div>

    <!-- notes drawer slides in from the LEFT -->
    <div class="backdrop" class:show={drawerOpen} onclick={closeNotes}></div>
    <aside class="notes" class:open={drawerOpen} style={`--trunk:${dColor}`} aria-live="polite">
      <button type="button" class="notes-close" onclick={closeNotes} aria-label="Close notes">✕</button>
      <p class="notes-kicker">{dKind}{dTrunk ? ` · ${dTrunk}` : ''}</p>
      <h2 class="notes-title">{dName}</h2>

      <div class="notes-stats">
        <div><dt>{fmt(dSize)}</dt><dd>fields beneath</dd></div>
        {#if dRoadmap}
          <div><dt>→</dt><dd>
            <button type="button" class="as-link" onclick={() => openSlice(drawerNode)}>open its roadmap</button>
            <a href={`${BASE}roadmap/${dRoadmap}`}>full page ↗</a>
          </dd></div>
        {/if}
      </div>

      {#if dDesc}
        <section>
          <h3>What it is</h3>
          <p>{dDesc}</p>
        </section>
      {/if}

      {#if dChildren.length}
        <section>
          <h3>Branches</h3>
          <ul class="link-list">
            {#each dChildren as c (c.idx)}
              <li><button type="button" onclick={() => focusNode(c.idx)}>{c.name}</button></li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if dRelated.length}
        <section>
          <h3>Related fields</h3>
          <ul class="link-list">
            {#each dRelated as r (r.idx)}
              <li><button type="button" onclick={() => focusNode(r.idx)}>{r.name}</button></li>
            {/each}
          </ul>
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

  <!-- sliced-in roadmap: the same dendrogram the roadmap section draws -->
  {#if slice}
    <div class="slice">
      <div id="sliceStage" class="slice-stage"></div>

      <div class="floats">
        <div class="panel title-panel">
          <p class="crumb">Roadmap{sliceParent ? ` · under ${sliceParent}` : ''}</p>
          <h1 class="sel-title" style={`color:${sliceColor}`}>{sliceTitle}</h1>
          <div class="progress">
            <div class="bar"><div class="fill" style={`width:${sliceTotal ? Math.round(100 * sliceDoneCount / sliceTotal) : 0}%;background:${sliceColor}`}></div></div>
            <span class="num">{sliceDoneCount}/{sliceTotal} done</span>
          </div>
        </div>
        <div class="panel tools">
          <button type="button" onclick={closeSlice}>← Atlas tree</button>
        </div>
        <p class="hint">click a topic for notes · drag to pan · scroll to zoom</p>
      </div>

      <div class="backdrop" class:show={sDrawerOpen} onclick={() => (sDrawerOpen = false)}></div>
      <aside class="notes" class:open={sDrawerOpen} style={`--trunk:${sliceColor}`}>
        <button type="button" class="notes-close" onclick={() => (sDrawerOpen = false)} aria-label="Close notes">✕</button>
        <p class="notes-kicker">
          {sdKind === 'optional' ? 'related field' : 'topic'}{sdKind === 'optional' ? '' : ` · ${LEVEL_NAMES[sdLevel] ?? `Level ${sdLevel + 1}`}`}
        </p>
        <h2 class="notes-title">{sdLabel}</h2>

        {#if sdKind === 'topic'}
          <button type="button" class="done-toggle" class:primary={sdDone} onclick={toggleSdDone}>
            {sdDone ? '✓ Completed — undo?' : 'Mark as completed'}
          </button>
        {/if}

        {#if sdDesc}
          <section>
            <h3>What it is</h3>
            <p>{sdDesc}</p>
          </section>
        {/if}

        {#if sdWiki}
          <section>
            <h3>Elsewhere</h3>
            <a class="wiki" href={`https://en.wikipedia.org/wiki/${sdWiki}`} target="_blank" rel="noopener noreferrer">
              Read on Wikipedia ↗
            </a>
          </section>
        {/if}
      </aside>
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
  :global(.xl) { font-size: 12.5px; }
  :global(.xl-0) { font-size: 16px; font-weight: 800; fill: #e8b76a; }
  :global(.xl-1) { font-size: 13.5px; font-weight: 700; fill: #e6e2d6; }
  :global(.xl-2) { font-size: 12.5px; }
  :global(.xl-3), :global(.xl-4) { font-size: 11.5px; fill: #9aa39c; }
  :global(.xc) { stroke: #0b0d0c; stroke-width: 1.5; }
  :global(.xc:hover) { filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.45)); }
  :global(.xc-leaf) { opacity: 0.85; }
  :global(.xc-more) { fill: #5c6660 !important; stroke-dasharray: 2 2; }

  .floats { position: absolute; inset: 0; pointer-events: none; z-index: 20; }
  .panel {
    pointer-events: auto;
    background: var(--glass); backdrop-filter: blur(10px);
    border: 1px solid var(--line); border-radius: 12px; padding: 10px 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }
  .title-panel { position: absolute; top: 14px; left: 72px; max-width: 420px; }
  .crumb { font-family: var(--font-data); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-muted); }
  .sel-title { font-family: var(--font-body); font-size: 20px; font-weight: 700; margin: 3px 0 2px; letter-spacing: -0.01em; }
  .sel-sub { font-size: 12px; color: var(--text-muted); }

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

  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 90;
    opacity: 0; transition: opacity 0.18s; pointer-events: none;
  }
  .backdrop.show { opacity: 1; pointer-events: auto; }

  .notes {
    position: fixed; top: 0; left: 0; bottom: 0; width: min(440px, 92vw); z-index: 100;
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
  .notes-title { font-family: var(--font-display); font-size: 26px; margin-bottom: 10px; padding-right: 28px; }
  .notes-stats { display: flex; gap: 22px; margin-bottom: 6px; }
  .notes-stats dt { font-size: 17px; font-weight: 700; color: var(--trunk); }
  .notes-stats dd { font-size: 11px; color: var(--text-muted); }
  .notes-stats a { color: var(--text-secondary); font-size: 11px; }
  .notes-stats a:hover { color: var(--trunk); }
  .notes section { border-top: 1px solid var(--line); padding: 14px 0; }
  .notes section h3 {
    font-family: var(--font-data); font-size: 10.5px; text-transform: uppercase;
    letter-spacing: 0.12em; color: var(--text-muted); margin-bottom: 9px;
  }
  .notes p { color: #c8ccd1; font-size: 14px; line-height: 1.6; }
  .link-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .link-list button {
    background: none; border: none; padding: 0; cursor: pointer; text-align: left;
    color: var(--text-secondary); font: inherit; font-size: 13.5px;
  }
  .link-list button:hover { color: var(--trunk); }
  .wiki { font-size: 13.5px; color: var(--text-secondary); text-decoration: none; }
  .wiki:hover { color: var(--trunk); }

  /* ---------- sliced-in roadmap ---------- */
  .slice {
    position: fixed; inset: 0; z-index: 140;
    background: radial-gradient(ellipse at 28% 40%, #12151a 0%, #0b0d0c 70%);
  }
  .slice-stage { position: absolute; inset: 0; cursor: grab; }
  .slice-stage:active { cursor: grabbing; }

  :global(.slink) { fill: none; stroke: #333b44; stroke-width: 1.15; }
  :global(.snode) { cursor: pointer; }
  :global(.snode text) { font-family: var(--font-body); fill: #c8ccd1; }
  :global(.sl) { font-size: 13px; }
  :global(.sl-0) { font-size: 16px; font-weight: 800; fill: #e8b76a; }
  :global(.sl-1) { font-size: 13.5px; font-weight: 700; fill: #e6e2d6; }
  :global(.sl-2) { font-size: 12.5px; }
  :global(.sl-done) { fill: #86d99a !important; }
  :global(.sc) { stroke: #0b0d0c; stroke-width: 1.5; }
  :global(.sc:hover) { filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.45)); }
  :global(.sc-done) { fill: #3fb950 !important; }

  .slice .progress { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .slice .progress .bar {
    width: 150px; height: 6px; border-radius: 99px;
    background: var(--bg-tertiary); overflow: hidden; border: 1px solid var(--line);
  }
  .slice .progress .fill { height: 100%; transition: width 0.3s; }
  .slice .progress span { font-size: 11px; color: var(--text-muted); }

  .done-toggle {
    display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
    border-radius: 999px; border: 1px solid var(--line-light);
    background: transparent; color: var(--text-primary); font: inherit;
    font-size: 13px; font-weight: 600; padding: 7px 15px; margin: 2px 0 14px;
  }
  .done-toggle:hover { border-color: var(--text-secondary); }
  .done-toggle.primary { background: #274d33; border-color: #3fb950; color: #86d99a; }

  .as-link {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--text-secondary); font: inherit; font-size: 11px;
  }
  .as-link:hover { color: var(--trunk); }
  .notes-stats dd a { margin-left: 8px; }

  @media (max-width: 640px) {
    .title-panel { left: 64px; max-width: 70vw; }
    .tools { top: auto; bottom: 14px; right: 12px; }
    .hint { display: none; }
  }
</style>
