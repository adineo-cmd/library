<script lang="ts">
  /**
   * The constellation: the whole atlas, drifting.
   *
   * Every node a star, every link a thread. The positions are precomputed by
   * build-structure.mjs (taxonomy-layout.bin) — running a force simulation
   * here would spend CPU to arrive somewhere different on every visit — so
   * the frame loop's whole job is drift: a slow per-node sine offset that
   * makes the field breathe. Glow comes from pre-rendered radial sprites, one
   * per trunk colour, blitted per node; a live shadowBlur per node would be
   * nine thousand full-canvas blurs per frame and about four frames a second.
   *
   * Interactions: drag to pan, wheel to zoom, hover to identify, click to
   * isolate a neighbourhood. The cluster list toggles trunks; the sliders
   * set drift speed and link density.
   */
  import { onMount, tick } from 'svelte';

  interface Trunk { id: string; name: string; num: string; color: string }
  interface SNode {
    name: string; kind: string; trunk: number; parent: number; size: number;
    wiki: string | null; description: string | null;
  }

  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;

  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';

  let nodes: SNode[] = [];
  let trunks: Trunk[] = [];
  let xlinks: [number, number][] = [];
  let baseX: Float32Array;
  let baseY: Float32Array;

  // view transform
  let scale = 1;
  let fitScale = 1;
  let tx = 0;
  let ty = 0;

  // state
  let enabled: boolean[] = [];
  let driftSpeed = 0.5;
  let linkDensity = 0.35;
  let hover = -1;
  let selected = -1;

  // animation
  let raf = 0;
  let t0 = 0;
  let phases: Float32Array;
  let freqs: Float32Array;
  let amps: Float32Array;

  let readout = '';

  // per-trunk glow sprites
  const sprites: (HTMLCanvasElement | null)[] = [];

  function makeSprite(color: string): HTMLCanvasElement {
    const S = 64;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, color);
    g.addColorStop(0.25, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(0, 0, S, S);
    return c;
  }

  function fit() {
    const { width, height } = wrap.getBoundingClientRect();
    if (width < 2 || height < 2 || !baseX) return;
    // Robust bounds: a handful of far-flung outliers would otherwise shove
    // the whole constellation into one corner, so the frame is computed from
    // the 1st–99th percentile of each axis.
    const sx = Float32Array.from(baseX).sort();
    const sy = Float32Array.from(baseY).sort();
    const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
    const minX = q(sx, 0.01), maxX = q(sx, 0.99);
    const minY = q(sy, 0.01), maxY = q(sy, 0.99);
    const pad = 30;
    const w = Math.max(1e-6, maxX - minX);
    const h = Math.max(1e-6, maxY - minY);
    scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
    fitScale = scale;
    tx = pad - minX * scale + (width - pad * 2 - w * scale) / 2;
    ty = pad - minY * scale + (height - pad * 2 - h * scale) / 2;
  }

  const drawEdges = (ctx: CanvasRenderingContext2D, W: number, H: number) => {
    const density = linkDensity;
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(150, 160, 155, 0.16)';
    ctx.beginPath();
    // tree edges, sampled by density
    const step = Math.max(1, Math.floor(1 / Math.max(0.02, density)));
    let drawn = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (!enabled[nodes[i].trunk]) continue;
      const p = nodes[i].parent;
      if (p < 0 || (step > 1 && i % step !== 0)) continue;
      if (!enabled[nodes[p].trunk]) continue;
      ctx.moveTo(baseX[p] * scale + tx, baseY[p] * scale + ty);
      ctx.lineTo(baseX[i] * scale + tx, baseY[i] * scale + ty);
      drawn++;
    }
    ctx.stroke();
    // crosslinks: the atlas's real subject
    ctx.strokeStyle = 'rgba(190, 200, 195, 0.10)';
    ctx.beginPath();
    for (let e = 0; e < xlinks.length; e++) {
      if (e % Math.max(1, Math.round(1 / Math.max(0.02, density * 0.6))) !== 0) continue;
      const [a, b] = xlinks[e];
      if (!enabled[nodes[a].trunk] || !enabled[nodes[b].trunk]) continue;
      ctx.moveTo(baseX[a] * scale + tx, baseY[a] * scale + ty);
      ctx.lineTo(baseX[b] * scale + tx, baseY[b] * scale + ty);
      drawn++;
    }
    ctx.stroke();
  };

  const draw = (time: number) => {
    if (!canvas || !wrap || !baseX) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = wrap.getBoundingClientRect();
    if (width < 2 || height < 2) return;
    if (canvas.width !== Math.floor(width * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d0c';
    ctx.fillRect(0, 0, width, height);

    const t = (time - t0) / 1000;
    const focus = selected >= 0 ? selected : hover;

    // neighbourhood of the focus: same trunk + immediate family
    let focusSet: Set<number> | null = null;
    if (focus >= 0) {
      focusSet = new Set([focus]);
      const p = nodes[focus].parent;
      if (p >= 0) focusSet.add(p);
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].parent === focus) focusSet.add(i);
      }
      for (const [a, b] of xlinks) {
        if (a === focus) focusSet.add(b);
        else if (b === focus) focusSet.add(a);
      }
    }

    if (linkDensity > 0.02) drawEdges(ctx, width, height);

    // nodes: sprite blit per node, sized by field size
    const maxLog = Math.log(1 + Math.max(...nodes.map(n => n.size)));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!enabled[n.trunk]) continue;
      if (focusSet && !focusSet.has(i)) continue;
      const amp = driftSpeed * 7 * amps[i];
      const x = (baseX[i] + Math.sin(t * 0.32 * driftSpeed + phases[i]) * amp) * scale + tx;
      const y = (baseY[i] + Math.cos(t * 0.26 * driftSpeed + freqs[i] * 6.28) * amp * 0.8) * scale + ty;
      const rBase = 1.4 + (Math.log(1 + n.size) / maxLog) * (n.kind === 'field' ? 5 : 9);
      const r = rBase * Math.min(2.2, Math.max(0.55, scale / fitScale));
      const sprite = sprites[n.trunk];
      if (sprite) {
        const s = r * 6;
        ctx.globalAlpha = focusSet ? 0.95 : 0.8;
        ctx.drawImage(sprite, x - s / 2, y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
      if (i === focus) {
        ctx.fillStyle = trunks[n.trunk]?.color ?? '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (focus >= 0 && focusSet) {
      // dim veil over everything outside the neighbourhood
      ctx.fillStyle = 'rgba(10, 13, 12, 0.25)';
      ctx.fillRect(0, 0, width, height);
    }
  };

  const loop = (time: number) => {
    draw(time);
    raf = requestAnimationFrame(loop);
  };

  function nodeAt(px: number, py: number): number {
    let best = -1;
    let bestD = 14 * 14;
    for (let i = 0; i < baseX.length; i++) {
      if (!enabled[nodes[i].trunk]) continue;
      const dx = baseX[i] * scale + tx - px;
      const dy = baseY[i] * scale + ty - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  let dragging = false;
  let lastX = 0, lastY = 0;

  function onDown(e: MouseEvent) { dragging = true; lastX = e.clientX; lastY = e.clientY; }
  function onUp() { dragging = false; }
  function onMove(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    if (dragging) {
      tx += e.clientX - lastX;
      ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      return;
    }
    const i = nodeAt(e.clientX - r.left, e.clientY - r.top);
    hover = i;
    if (i >= 0) {
      const n = nodes[i];
      readout = `${n.name} · ${trunks[n.trunk]?.name ?? ''} · ${n.size.toLocaleString('en-US')} fields`;
    } else readout = '';
  }
  function onLeave() { hover = -1; readout = ''; }
  function onClick(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    const i = nodeAt(e.clientX - r.left, e.clientY - r.top);
    selected = selected === i ? -1 : i;
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0014);
    const next = Math.min(80, Math.max(0.05, scale * k));
    tx = mx - ((mx - tx) / scale) * next;
    ty = my - ((my - ty) / scale) * next;
    scale = next;
  }
  function reset() { fit(); }

  function toggleTrunk(ti: number) {
    enabled = enabled.map((v, i) => (i === ti ? !v : v));
  }
  function soloTrunk(ti: number) {
    enabled = enabled.map((_, i) => i === ti);
  }
  function showAll() { enabled = trunks.map(() => true); }

  onMount(async () => {
    try {
      const [sRes, lRes] = await Promise.all([
        fetch('/data/artifacts/structure.json'),
        fetch('/data/artifacts/taxonomy-layout.bin'),
      ]);
      if (!sRes.ok || !lRes.ok) throw new Error('artifact fetch failed');
      const s = await sRes.json();
      nodes = s.nodes;
      trunks = s.trunks;
      xlinks = s.xlinks;
      const buf = await lRes.arrayBuffer();
      const f32 = new Float32Array(buf);
      const n = s.nodeCount;
      baseX = f32.slice(0, n);
      baseY = f32.slice(n, n * 2);
      phases = new Float32Array(n);
      freqs = new Float32Array(n);
      amps = new Float32Array(n);
      // deterministic phase field: positions hash into phases
      let seed = 42;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        phases[i] = (seed / 0x7fffffff) * Math.PI * 2;
        freqs[i] = ((seed >> 7) & 0xff) / 255;
        amps[i] = 0.6 + ((seed >> 15) & 0x7) / 7;
      }
      enabled = trunks.map(() => true);
      for (const t of trunks) sprites.push(makeSprite(t.color));
      status = 'ready';
      await tick();
      fit();
      t0 = performance.now();
      raf = requestAnimationFrame(loop);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }

    const ro = new ResizeObserver(() => fit());
    if (wrap) ro.observe(wrap);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  });
</script>

<div class="constellation">
  {#if status === 'loading'}
    <p class="state" role="status">Positioning {nodes.length.toLocaleString('en-US')} stars…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The constellation could not be drawn.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <aside class="panel">
      <p class="panel__label">Clusters</p>
      <ul class="clusters">
        {#each trunks as t, ti (t.id)}
          <li>
            <button
              type="button"
              class="cluster"
              class:cluster--off={!enabled[ti]}
              style={`--trunk:${t.color}`}
              onclick={() => toggleTrunk(ti)}
              ondblclick={() => soloTrunk(ti)}
              title="click to toggle · double-click to solo"
            >
              <i class="cluster__dot"></i>{t.name}
              <span class="cluster__num num">{t.num}</span>
            </button>
          </li>
        {/each}
      </ul>
      <button type="button" class="showall" onclick={showAll}>show all</button>

      <p class="panel__label">Drift speed</p>
      <input class="slider" type="range" min="0" max="1" step="0.01" bind:value={driftSpeed} />
      <p class="panel__label">Link density</p>
      <input class="slider" type="range" min="0" max="1" step="0.01" bind:value={linkDensity} />
      <button type="button" class="showall" onclick={reset}>reset view</button>
    </aside>

    <div class="sky" bind:this={wrap}>
      <canvas
        bind:this={canvas}
        onmousedown={onDown}
        onmouseup={onUp}
        onmousemove={onMove}
        onmouseleave={onLeave}
        onclick={onClick}
        onwheel={onWheel}
        role="img"
        aria-label="Constellation of {nodes.length} disciplines. Use the domains view for a keyboard-navigable list."
      ></canvas>
      <p class="hint">drag to pan · scroll to zoom · click a star to isolate its neighbourhood</p>
      {#if readout}
        <p class="readout" aria-live="polite">{readout}</p>
      {/if}
      {#if selected >= 0 && nodes[selected]}
        <div class="picked">
          <div>
            <strong>{nodes[selected].name}</strong>
            <span class="num">{trunks[nodes[selected].trunk]?.name} · {nodes[selected].size.toLocaleString('en-US')} fields · depth {nodes[selected].kind === 'field' ? '—' : nodes[selected].kind}</span>
          </div>
          <a
            href={nodes[selected].wiki ? `https://en.wikipedia.org/wiki/${nodes[selected].wiki}` : '/domains'}
            target={nodes[selected].wiki ? '_blank' : undefined}
            rel="noopener noreferrer"
          >{nodes[selected].wiki ? 'Wikipedia ↗' : 'explore ↗'}</a>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .constellation {
    display: grid;
    grid-template-columns: 250px 1fr;
    gap: 18px;
    min-height: 560px;
  }
  .state { padding: 64px 0; color: var(--text-muted); font-size: 14px; grid-column: 1 / -1; }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }

  .panel {
    background: var(--bg-secondary);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 18px;
    align-self: start;
  }
  .panel__label {
    font-family: var(--font-data); font-size: 9.5px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--text-muted);
    margin: 14px 0 8px;
  }
  .panel__label:first-child { margin-top: 0; }

  .clusters { list-style: none; padding: 0; margin: 0; }
  .clusters li + li { border-top: 1px solid var(--line); }
  .cluster {
    display: flex; align-items: center; gap: 9px; width: 100%;
    background: none; border: none; cursor: pointer;
    color: var(--text-secondary); font-size: 13px;
    padding: 9px 4px; text-align: left;
    transition: color 0.15s ease, opacity 0.15s ease;
  }
  .cluster:hover { color: var(--text-primary); }
  .cluster--off { opacity: 0.38; }
  .cluster__dot {
    width: 9px; height: 9px; border-radius: 50%; background: var(--trunk);
    box-shadow: 0 0 8px var(--trunk);
  }
  .cluster__num { margin-left: auto; font-size: 9.5px; color: var(--text-muted); }
  .showall {
    width: 100%; margin-top: 8px;
    background: none; border: 1px solid var(--line); border-radius: 6px;
    color: var(--text-muted); font-size: 11px; padding: 6px; cursor: pointer;
  }
  .showall:hover { color: var(--text-secondary); }

  .slider { width: 100%; accent-color: var(--accent); }

  .sky {
    position: relative;
    background: #0a0d0c;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    min-height: 560px;
  }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; position: absolute; inset: 0; }
  canvas:active { cursor: grabbing; }

  .hint {
    position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
    font-family: var(--font-data); font-size: 10px; letter-spacing: 0.08em;
    color: rgba(230, 226, 214, 0.4); pointer-events: none;
  }
  .readout {
    position: absolute; top: 12px; left: 14px;
    font-family: var(--font-data); font-size: 11px;
    color: var(--text-secondary);
    background: rgba(10, 13, 12, 0.75);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
    pointer-events: none;
  }
  .picked {
    position: absolute; bottom: 14px; right: 14px;
    display: flex; align-items: center; gap: 16px;
    background: rgba(16, 20, 18, 0.9);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    border-radius: 8px;
    padding: 10px 14px;
  }
  .picked strong { display: block; font-size: 13.5px; color: var(--text-primary); }
  .picked span { font-size: 10.5px; color: var(--text-muted); }
  .picked a { font-size: 11.5px; color: var(--accent); text-decoration: none; white-space: nowrap; }

  @media (max-width: 860px) {
    .constellation { grid-template-columns: 1fr; }
    .sky { min-height: 420px; }
  }
</style>
