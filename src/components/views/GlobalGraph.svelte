<script lang="ts">
  /**
   * The atlas as a field of points, on the precomputed positions in
   * layout.bin.
   *
   * Canvas 2D, not SVG: 30,039 nodes and 16,091 edges is far past where SVG
   * stops being comfortable, and the layout is already solved offline by
   * `scripts/layout.mjs` — running a force simulation here would spend CPU to
   * arrive somewhere different on every visit and would fight the determinism
   * the build guarantees.
   *
   * The packed layout is a fixed-width binary, so it is parsed by
   * `parseLayout` from the shared loader rather than re-derived here.
   */
  import { onMount, tick } from 'svelte';
  import { loadConcepts, loadCrosslinks, parseLayout } from '../../lib/artifacts/load';
  import type { Concept, LayoutArrays } from '../../lib/artifacts/types';

  const BASE = '/data/artifacts';

  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;
  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error: string | null = null;

  let concepts: Concept[] = [];
  let layout: LayoutArrays | null = null;

  // View transform. Points are stored in whatever range the solver produced
  // (it is not normalised), so the first fit computes a scale to fit the box.
  let scale = 1;
  let fitScale = 1;
  let tx = 0;
  let ty = 0;

  let showTree = true;
  let showCross = true;
  let hover: number | null = null;
  let selected: number | null = null;

  let readout = '';

  // Neighbours of the focused node, for the crosslink emphasis pass.
  let linked = new Set<number>();

  let theme = 'dark';

  const NODE_MIN = 1.6;
  const NODE_MAX = 9;

  function ink() {
    // Read the tokens off the live element so the canvas follows the theme
    // toggle instead of holding a second copy of the palette.
    const cs = getComputedStyle(wrap);
    const v = (n: string, f: string) => (cs.getPropertyValue(n).trim() || f);
    return {
      bg: v('--bg-primary', '#0c0f0e'),
      text: v('--text-primary', '#e6e2d6'),
      muted: v('--text-muted', '#5c6660'),
      accent: v('--accent', '#c9a227'),
      line: v('--line-light', '#2b3530'),
      secondary: v('--text-secondary', '#9aa39c'),
    };
  }

  /** Normalise the two coordinate ranges into the viewport. */
  function fit() {
    if (!layout) return;
    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const { x, y } = layout;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < x.length; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    const pad = 24;
    const w = Math.max(1e-6, maxX - minX);
    const h = Math.max(1e-6, maxY - minY);
    scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
    // Remember the scale that frames everything: zoom is then expressible as a
    // multiple of "see the whole atlas", which is the only zoom metric that
    // means anything to a reader.
    fitScale = scale;
    tx = pad - minX * scale + (width - pad * 2 - w * scale) / 2;
    ty = pad - minY * scale + (height - pad * 2 - h * scale) / 2;
  }

  function toScreen(i: number): [number, number] {
    return [layout!.x[i] * scale + tx, layout!.y[i] * scale + ty];
  }

  function draw() {
    if (!layout || !canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = wrap.getBoundingClientRect();
    // A zero-sized box means the container is display:none or not laid out yet;
    // painting then would write a 0x0 buffer that never recovers.
    if (width < 2 || height < 2) return;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const c = ink();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);

    // At the fitted zoom, 30,039 nodes and 40,800 edges render as a grey
    // hairball with nothing legible in it — the map has to be a texture first
    // and a structure second. Edges appear only once the reader has zoomed in
    // far enough for them to connect anything, and node dots shrink to the
    // smallest size while zoomed out so density reads as tone rather than as
    // 30,000 overlapping discs.
    const zoom = fitScale > 0 ? scale / fitScale : 1;
    const detail = zoom >= 2.5;
    const focus = selected ?? hover;

    if (showTree && detail) {
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const { treeSrc, treeDst } = layout;
      for (let e = 0; e < treeSrc.length; e++) {
        const a = treeSrc[e], b = treeDst[e];
        if (linked.size && !(linked.has(a) && linked.has(b))) continue;
        const [ax, ay] = [layout.x[a] * scale + tx, layout.y[a] * scale + ty];
        const [bx, by] = [layout.x[b] * scale + tx, layout.y[b] * scale + ty];
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }

    if (showCross && detail) {
      const { crossSrc, crossDst, crossWeight } = layout;
      ctx.strokeStyle = c.muted;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let e = 0; e < crossSrc.length; e++) {
        const a = crossSrc[e], b = crossDst[e];
        if (linked.size && !(linked.has(a) && linked.has(b))) continue;
        const [ax, ay] = [layout.x[a] * scale + tx, layout.y[a] * scale + ty];
        const [bx, by] = [layout.x[b] * scale + tx, layout.y[b] * scale + ty];
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Nodes. Size tracks article count on a sqrt scale so a category with
    // 500k articles does not become a disc that hides its neighbours.
    const { x, y } = layout;
    const counts = concepts.map(n => n.articleCount);
    const maxCount = Math.max(1, ...counts);
    ctx.fillStyle = c.secondary;
    // Dot size is capped while zoomed out: at fit, 30k discs drawn at the
    // scaled range merge into a solid mass and the count information is lost.
    const hi = detail ? NODE_MAX : 1.9;
    const lo = detail ? NODE_MIN : 0.6;
    for (let i = 0; i < x.length; i++) {
      if (linked.size && !linked.has(i)) continue;
      const r = lo + Math.sqrt(counts[i] / maxCount) * (hi - lo);
      ctx.beginPath();
      ctx.arc(x[i] * scale + tx, y[i] * scale + ty, r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (focus !== null) {
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(x[focus] * scale + tx, y[focus] * scale + ty, 5, 0, Math.PI * 2);
      ctx.fill();
      // Label the focused node so the accent means something.
      const [fx, fy] = toScreen(focus);
      ctx.font = '12px "IBM Plex Mono", monospace';
      ctx.fillStyle = c.text;
      ctx.fillText(concepts[focus].name, fx + 9, fy + 4);
    }
  }

  function nodeAt(px: number, py: number): number | null {
    if (!layout) return null;
    // Search a small neighbourhood rather than all 30k points per mousemove.
    let best: number | null = null;
    let bestD = 12;
    for (let i = 0; i < layout.x.length; i++) {
      const dx = layout.x[i] * scale + tx - px;
      const dy = layout.y[i] * scale + ty - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onDown(e: MouseEvent) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
  }
  function onUp() { dragging = false; }
  function onDrag(e: MouseEvent) {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    draw();
  }

  function onMove(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    const i = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (i !== hover) { hover = i; draw(); }
    if (i !== null) {
      const n = concepts[i];
      const p = n.parent !== -1 ? concepts[n.parent]?.name : null;
      readout = `${n.name} · ${n.articleCount.toLocaleString('en-US')} articles${p ? ` · under ${p}` : ''}`;
    } else {
      readout = '';
    }
  }

  /**
   * Panning and hover share one mousemove: while a drag is in progress the
   * pointer is being used to move the map, so hovering would pick a node out
   * from under the cursor and redraw the canvas on every pixel of the drag.
   */
  function onPointerMove(e: MouseEvent) {
    if (dragging) { onDrag(e); return; }
    onMove(e);
  }

  function onLeave() {
    hover = null; readout = ''; draw();
  }

  function onClick(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    const i = nodeAt(e.clientX - r.left, e.clientY - r.top);
    selected = selected === i ? null : i;
    linked = new Set();
    if (selected !== null) {
      const n = concepts[selected];
      if (n.parent !== -1) linked.add(n.parent);
      // Every crosslink touching the selection, so the node's web shows at once.
      if (layout) {
        for (let e = 0; e < layout.crossSrc.length; e++) {
          if (layout.crossSrc[e] === selected) linked.add(layout.crossDst[e]);
          else if (layout.crossDst[e] === selected) linked.add(layout.crossSrc[e]);
        }
      }
      linked.add(selected);
    }
    draw();
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0016);
    const next = Math.min(400, Math.max(0.02, scale * k));
    // Zoom about the cursor so the point under it stays put.
    tx = mx - ((mx - tx) / scale) * next;
    ty = my - ((my - ty) / scale) * next;
    scale = next;
    draw();
  }

  function reset() { fit(); draw(); }

  // Paint once the component has actually mounted. The canvas is inside a
  // `{:else}` on `status`, so it does not exist in the DOM until after this
  // block's assignments flush — drawing inline here drew onto a detached
  // element at its default 300x150, leaving a blank canvas on screen.
  onMount(() => {
    tick().then(() => { fit(); draw(); });
  });

  onMount(async () => {
    try {
      const [cRes, xRes, lRes] = await Promise.all([
        fetch(`${BASE}/concepts.json`),
        fetch(`${BASE}/crosslinks.json`),
        fetch(`${BASE}/layout.bin`),
      ]);
      if (!cRes.ok || !xRes.ok || !lRes.ok) {
        throw new Error(`artifact fetch failed (${cRes.status}/${xRes.status}/${lRes.status})`);
      }
      concepts = loadConcepts(await cRes.json()).nodes;
      const cross = loadCrosslinks(await xRes.json());
      const rootCount = concepts.length - concepts.filter(n => n.parent !== -1).length;
      layout = parseLayout(
        await lRes.arrayBuffer(),
        concepts.length,
        rootCount,
        cross.edges.length,
      );
      theme = document.documentElement.getAttribute('data-theme') || 'dark';
      status = 'ready';
      // `draw` waits for the canvas itself and is a no-op if it is not there.
      tick().then(() => draw());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });

  // The canvas is painted from CSS custom properties, so a theme change has to
  // repaint; a MutationObserver is the cheapest way to catch the attribute flip.
  // The ResizeObserver refits on container resize. Both are registered once the
  // element exists and torn down with the component — a reactive block cannot
  // `return` a disposer, and re-running one would leak a second observer.
  onMount(() => {
    if (!wrap) return;
    const obs = new MutationObserver(() => {
      theme = document.documentElement.getAttribute('data-theme') || 'dark';
      draw();
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const ro = new ResizeObserver(() => { fit(); draw(); });
    ro.observe(wrap);

    return () => { obs.disconnect(); ro.disconnect(); };
  });
</script>

<div class="graph" bind:this={wrap}>
  {#if status === 'loading'}
    <p class="state" role="status">Laying out the atlas…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The atlas could not be drawn.</p>
      <p class="num">{error}</p>
    </div>
  {:else}
    <canvas
      bind:this={canvas}
      role="img"
      aria-label="Map of {concepts.length} Wikipedia categories. Use the browse view for a keyboard-navigable list of the same data."
      onmousemove={onPointerMove}
      onmouseleave={onLeave}
      onclick={onClick}
      onwheel={onWheel}
      onmousedown={onDown}
      onmouseup={onUp}
    ></canvas>

    <div class="legend">
      <span class="legend__item"><i class="swatch swatch--tree"></i>Tree structure</span>
      <span class="legend__item"><i class="swatch swatch--cross"></i>Cross-links by shared articles</span>
      <span class="legend__item"><i class="swatch swatch--node"></i>Dot size by article count</span>
    </div>

    <div class="controls">
      <label><input type="checkbox" bind:checked={showTree} /> Tree edges</label>
      <label><input type="checkbox" bind:checked={showCross} /> Cross-links</label>
      <button type="button" onclick={reset}>Fit</button>
    </div>

    {#if readout}
      <p class="readout" aria-live="polite">{readout}</p>
    {/if}

    {#if selected !== null}
      {@const s = concepts[selected]}
      <div class="picked">
        <div>
          <strong>{s.name}</strong>
          <span class="num">{s.articleCount.toLocaleString('en-US')} articles · depth {s.depth} · {linked.size - 1} linked</span>
        </div>
        <button type="button" onclick={() => { selected = null; linked = new Set(); draw(); }}>Clear</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 520px;
    background: var(--bg-primary);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
  }

  canvas { display: block; cursor: grab; }
  canvas:active { cursor: grabbing; }

  .state { padding: 40px; color: var(--text-muted); font-size: 14px; }
  .state--error p { margin-bottom: 6px; }

  .legend, .controls, .readout, .picked {
    position: absolute;
    background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .legend {
    top: 14px; left: 14px;
    display: flex; flex-wrap: wrap; gap: 8px 18px;
    padding: 9px 13px;
  }
  .legend__item { display: flex; align-items: center; gap: 7px; }
  .swatch { width: 14px; height: 1px; display: inline-block; }
  .swatch--tree { background: var(--line-light); height: 1px; }
  .swatch--cross { background: var(--text-muted); height: 1px; opacity: 0.6; }
  .swatch--node { background: var(--text-secondary); width: 5px; height: 5px; border-radius: 50%; }

  .controls {
    top: 14px; right: 14px;
    display: flex; align-items: center; gap: 14px;
    padding: 8px 13px;
  }
  .controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .controls input { accent-color: var(--accent); }
  .controls button {
    background: none; border: 1px solid var(--line); color: var(--text-muted);
    font-size: 11px; padding: 4px 10px; border-radius: 2px; cursor: pointer;
  }
  .controls button:hover { color: var(--text-secondary); border-color: var(--line-light); }
  .controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .readout {
    bottom: 14px; left: 14px;
    padding: 7px 12px;
    font-family: var(--font-data);
    color: var(--text-muted);
  }

  .picked {
    bottom: 14px; right: 14px;
    display: flex; align-items: center; gap: 14px;
    padding: 10px 14px;
    border-left: 2px solid var(--accent);
  }
  .picked strong { display: block; font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .picked span { font-size: 11px; color: var(--text-muted); }
  .picked button {
    background: none; border: 1px solid var(--line); color: var(--text-muted);
    font-size: 11px; padding: 4px 10px; border-radius: 2px; cursor: pointer;
  }
  .picked button:hover { color: var(--text-secondary); border-color: var(--line-light); }

  @media (max-width: 900px) {
    .legend { display: none; }
    .controls { top: auto; bottom: 14px; right: 14px; }
    .graph { min-height: 420px; }
  }
</style>
