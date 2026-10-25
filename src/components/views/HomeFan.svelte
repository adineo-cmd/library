<script lang="ts">
  /**
   * The home view: one root, and the eight trunks fanned out from it.
   *
   * The OSINT-framework idiom — a root node at the left edge with its
   * children arcing away in a smooth vertical fan — is the whole interface.
   * Every path is a single cubic bezier, so the fan is cheap to draw and
   * reads as one gesture rather than as a diagram. Hovering a label warms
   * its curve; clicking follows it to the domains view.
   */
  import { onMount } from 'svelte';

  // BASE_URL is '/' in dev and '/memex/' on Pages — every fetch and in-site
  // link must go through it or the deployed site 404s.
  const BASE = import.meta.env.BASE_URL;

  interface Trunk {
    id: string; name: string; num: string; color: string;
    fieldCount: number; domainCount: number;
  }

  let trunks: Trunk[] = [];
  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';
  let hover: number | null = null;

  // Geometry: the root sits at the left, labels spread down the right side.
  const W = 980;
  const H = 620;
  const ROOT = { x: 150, y: H / 2 };
  const LABEL_X = 700;
  const TOP = 80;

  // Distribute labels evenly across the available height.
  const labelY = (i: number, n: number) =>
    TOP + ((H - TOP * 2) * i) / Math.max(1, n - 1);

  const path = (y: number) => {
    const dx = LABEL_X - ROOT.x;
    const c1x = ROOT.x + dx * 0.45;
    const c2x = ROOT.x + dx * 0.75;
    return `M ${ROOT.x} ${ROOT.y} C ${c1x} ${ROOT.y}, ${c2x} ${y}, ${LABEL_X} ${y}`;
  };

  onMount(async () => {
    try {
      const res = await fetch(`${BASE}data/artifacts/structure.json`);
      if (!res.ok) throw new Error(`structure.json responded ${res.status}`);
      const s = await res.json();
      const fieldCount = new Array(s.trunks.length).fill(0);
      const domainCount = new Array(s.trunks.length).fill(0);
      for (const n of s.nodes) {
        if (n.kind === 'field') fieldCount[n.trunk]++;
        if (n.kind === 'domain' && !n.id.startsWith('other:')) domainCount[n.trunk]++;
      }
      trunks = s.trunks.map((t: any, i: number) => ({
        id: t.id, name: t.name, color: t.color,
        fieldCount: fieldCount[i], domainCount: domainCount[i],
      }));
      status = 'ready';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'error';
    }
  });

  const fmt = (n: number) => n.toLocaleString('en-US');
</script>

<div class="fan">
  {#if status === 'loading'}
    <p class="state" role="status">Growing the atlas…</p>
  {:else if status === 'error'}
    <div class="state state--error" role="alert">
      <p>The atlas could not be loaded.</p>
      <p class="state__detail">{error}</p>
    </div>
  {:else}
    <svg viewBox="0 0 {W} {H}" role="img" aria-label="The {trunks.length} trunks of the atlas fanning out from a single root">
      <defs>
        <radialGradient id="rootGlow">
          <stop offset="0%" stop-color="#e8b76a" stop-opacity="0.55" />
          <stop offset="45%" stop-color="#e8b76a" stop-opacity="0.16" />
          <stop offset="100%" stop-color="#e8b76a" stop-opacity="0" />
        </radialGradient>
      </defs>

      <circle cx={ROOT.x} cy={ROOT.y} r="150" fill="url(#rootGlow)" />

      {#each trunks as t, i}
        {@const y = labelY(i, trunks.length)}
        {@const active = hover === i}
        <path
          class="arc"
          d={path(y)}
          fill="none"
          stroke={active ? t.color : 'var(--line-light)'}
          stroke-width={active ? 1.6 : 1}
          opacity={hover === null || active ? 1 : 0.35}
        />
      {/each}

      <!-- root drawn above its arcs -->
      <circle cx={ROOT.x} cy={ROOT.y} r="9" fill="#e8b76a" />
      <text class="root-label" x={ROOT.x + 18} y={ROOT.y + 4}>Arbor Root</text>

      {#each trunks as t, i}
        {@const y = labelY(i, trunks.length)}
        {@const active = hover === i}
        <g
          class="trunk"
          class:active
          onmouseenter={() => (hover = i)}
          onmouseleave={() => (hover = null)}
        >
          <circle cx={LABEL_X} cy={y} r={active ? 7 : 5} fill={t.color} />
          <a href={`${BASE}domains#${t.id}`}>
            <text class="trunk-name" x={LABEL_X + 16} y={y + 4} fill={active ? t.color : 'var(--text-primary)'}>
              {t.name}
            </text>
          </a>
          <text class="trunk-meta" x={LABEL_X + 16} y={y + 19}>{t.domainCount} domains · {fmt(t.fieldCount)} fields</text>
        </g>
      {/each}
    </svg>
  {/if}
</div>

<style>
  .fan {
    position: relative;
    width: 100%;
    max-width: 980px;
    margin: 24px auto 0;
  }

  .state {
    padding: 64px 0;
    color: var(--text-muted);
    font-size: 14px;
  }
  .state--error p { margin-bottom: 8px; }
  .state__detail { color: var(--text-secondary); font-size: 12px; }

  svg { width: 100%; height: auto; display: block; }

  .arc {
    transition: opacity 0.25s ease, stroke 0.25s ease;
  }

  .trunk { cursor: pointer; }
  .trunk circle { transition: r 0.2s ease; }
  .trunk-name {
    font-family: var(--font-body);
    font-size: 16px;
    fill: var(--text-primary);
    transition: fill 0.2s ease;
  }
  .trunk-meta {
    font-family: var(--font-data);
    font-size: 10px;
    fill: var(--text-muted);
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .trunk.active .trunk-meta { opacity: 0.9; }

  .root-label {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 19px;
    fill: var(--text-primary);
  }

  @media (max-width: 720px) {
    .trunk-meta { display: none; }
    .trunk-name { font-size: 14px; }
  }
</style>
