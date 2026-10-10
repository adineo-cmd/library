<script>
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';

  let { nodes = [], links = [], clusters = [] } = $props();
  let container = $state(null);
  let simulation = $state(null);
  let selectedNode = $state(null);

  const clusterColors = Object.fromEntries(clusters.map((c) => [c.name, c.color]));

  let driftSpeed = $state(30);
  let linkDensity = $state(50);
  let visibleClusters = $state(new Set(clusters.map((c) => c.name)));

  // Cross-links between trunks — the interesting part of the atlas is where
  // fields touch each other (neuroscience ↔ psychology, math ↔ physics...).
  function buildGraphData() {
    const crossLinks = links.filter((l) => l.source !== l.target);
    const maxLinks = Math.round(((crossLinks.length * linkDensity) / 100) || crossLinks.length);
    return {
      nodes: nodes.filter((n) => visibleClusters.has(n.cluster)),
      links: crossLinks.slice(0, maxLinks),
    };
  }

  onMount(() => {
    if (typeof window === 'undefined') return;
    if (!container || nodes.length === 0) return;
    initGraph();
    window.addEventListener('resize', handleResize);
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('resize', handleResize);
    if (simulation) simulation.stop();
    if (container) d3.select(container).selectAll('*').remove();
  });

  function handleResize() {
    if (typeof window === 'undefined') return;
    if (container) initGraph();
  }

  // Re-run when sliders or cluster filters change
  $effect(() => {
    driftSpeed;
    linkDensity;
    visibleClusters;
    if (container && nodes.length > 0) initGraph();
  });

  function toggleCluster(name) {
    const next = new Set(visibleClusters);
    if (next.has(name)) {
      if (next.size > 1) next.delete(name);
    } else {
      next.add(name);
    }
    visibleClusters = next;
  }

  function initGraph() {
    if (!container) return;
    // Only clear the svg layer — the HTML control panel stays mounted.
    d3.select(container).selectAll('svg').remove();
    selectedNode = null;

    const width = container.clientWidth;
    const height = container.clientHeight;
    const { nodes: visNodes, links: visLinks } = buildGraphData();

    const svg = d3
      .select(container)
      .append('svg')
      .attr('class', 'graph-svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    // Subtle starfield backdrop
    const bg = svg.append('g').attr('class', 'starfield');
    for (let s = 0; s < 60; s++) {
      bg.append('circle')
        .attr('cx', Math.random() * width)
        .attr('cy', Math.random() * height)
        .attr('r', Math.random() * 1.2)
        .attr('fill', '#e8e4d9')
        .attr('opacity', 0.04 + Math.random() * 0.08);
    }

    const g = svg.append('g');
    const zoom = d3.zoom().scaleExtent([0.2, 5]).on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
    svg.call(zoom);

    // Cluster anchors pull members toward their own region of the sky
    const angle = d3.scalePoint().domain([...visibleClusters]).range([0, 2 * Math.PI]);
    const radius = Math.min(width, height) * 0.28;
    const anchorX = (cluster) => width / 2 + radius * Math.cos(angle(cluster) ?? 0);
    const anchorY = (cluster) => height / 2 + radius * Math.sin(angle(cluster) ?? 0);

    const jitter = driftSpeed / 100;

    simulation = d3
      .forceSimulation(visNodes)
      .force('link', d3.forceLink(visLinks).id((d) => d.id).distance(90).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius((d) => d.size * 1.8))
      .force('x', d3.forceX((d) => anchorX(d.cluster)).strength(0.18))
      .force('y', d3.forceY((d) => anchorY(d.cluster)).strength(0.18))
      .velocityDecay(0.35 - jitter * 0.15);

    const link = g
      .append('g')
      .selectAll('line')
      .data(visLinks)
      .enter()
      .append('line')
      .attr('stroke', '#2a2a2a')
      .attr('stroke-width', 1)
      .attr('opacity', 0.6);

    const node = g
      .append('g')
      .selectAll('g')
      .data(visNodes)
      .enter()
      .append('g')
      .style('cursor', 'pointer')
      .call(
        d3
          .drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended)
      );

    // Glow circle
    node
      .append('circle')
      .attr('class', 'glow')
      .attr('r', (d) => d.size * 2.5)
      .attr('fill', (d) => clusterColors[d.cluster] || '#888')
      .attr('opacity', 0.15);

    // Core circle
    node
      .append('circle')
      .attr('class', 'core')
      .attr('r', (d) => d.size)
      .attr('fill', (d) => clusterColors[d.cluster] || '#888')
      .attr('stroke', '#0a0a0a')
      .attr('stroke-width', 1.5);

    // Labels appear on larger stars so the sky stays readable
    node
      .filter((d) => d.size >= 10)
      .append('text')
      .attr('dy', (d) => -d.size - 6)
      .attr('text-anchor', 'middle')
      .attr('fill', '#888888')
      .attr('font-size', '10px')
      .attr('font-family', 'Inter, sans-serif')
      .attr('pointer-events', 'none')
      .text((d) => d.label);

    node.on('mouseenter', function (event, d) {
      d3.select(this).select('.glow').transition().duration(200).attr('opacity', 0.4);
      d3.select(this).select('.core').transition().duration(200).attr('r', d.size * 1.3);
      link
        .attr('stroke', (l) => (l.source.id === d.id || l.target.id === d.id ? clusterColors[d.cluster] : '#2a2a2a'))
        .attr('opacity', (l) => (l.source.id === d.id || l.target.id === d.id ? 0.9 : 0.25));
    });

    node.on('mouseleave', function (event, d) {
      d3.select(this).select('.glow').transition().duration(200).attr('opacity', 0.15);
      d3.select(this).select('.core').transition().duration(200).attr('r', d.size);
      link.attr('stroke', '#2a2a2a').attr('opacity', 0.6);
    });

    node.on('click', (event, d) => {
      event.stopPropagation();
      selectedNode = d;
    });

    svg.on('click', () => {
      selectedNode = null;
    });

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);

      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
  }
</script>

<div class="graph-canvas" bind:this={container}>
  <div class="panel">
    <h3 class="panel-title">Clusters</h3>
    <ul class="cluster-list">
      {#each clusters as cluster (cluster.name)}
        <li class="cluster-item">
          <button
            type="button"
            class="cluster-toggle"
            class:off={!visibleClusters.has(cluster.name)}
            onclick={() => toggleCluster(cluster.name)}
          >
            <span class="cluster-dot" style="background-color: {cluster.color}"></span>
            <span class="cluster-name">{cluster.name}</span>
          </button>
        </li>
      {/each}
    </ul>

    <div class="slider-group">
      <label class="slider-label" for="driftSlider">Drift speed</label>
      <input id="driftSlider" type="range" min="0" max="100" value={driftSpeed} class="custom-slider"
        oninput={(e) => (driftSpeed = Number(e.currentTarget.value))} />
    </div>

    <div class="slider-group">
      <label class="slider-label" for="densitySlider">Link density</label>
      <input id="densitySlider" type="range" min="10" max="100" value={linkDensity} class="custom-slider"
        oninput={(e) => (linkDensity = Number(e.currentTarget.value))} />
    </div>

    <p class="panel-note">{nodes.length} fields · {links.length} threads</p>
  </div>
</div>

{#if selectedNode}
  <div class="node-card">
    <span class="node-cluster" style="color: {clusterColors[selectedNode.cluster]}">{selectedNode.cluster}</span>
    <h4 class="node-title">{selectedNode.label}</h4>
    {#if selectedNode.description}
      <p class="node-desc">{selectedNode.description}</p>
    {/if}
    <a class="node-link" href="/domains?open={encodeURIComponent(selectedNode.label)}">explore in the tree →</a>
  </div>
{/if}

<style>
  .graph-canvas {
    width: 100%;
    height: 100%;
    background: var(--bg-secondary);
    border-radius: 8px;
    overflow: hidden;
    position: relative;
  }

  :global(.graph-svg) {
    position: absolute;
    inset: 0;
  }

  .panel {
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 5;
    width: 210px;
    max-height: calc(100% - 32px);
    overflow-y: auto;
    background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
    border: 1px solid var(--line-light);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    backdrop-filter: blur(4px);
  }

  .panel-title {
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0;
  }

  .cluster-list {
    list-style: none;
    padding: 0;
    margin: 12px 0 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .cluster-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    color: var(--text-secondary);
    padding: 0;
    transition: opacity 0.2s ease;
  }

  .cluster-toggle.off {
    opacity: 0.35;
  }

  .cluster-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .cluster-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .slider-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .slider-label {
    font-size: 10px;
    color: var(--text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .custom-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    background: var(--line-light);
    border-radius: 2px;
    outline: none;
  }

  .custom-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--bg-primary);
  }

  .custom-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--bg-primary);
  }

  .panel-note {
    margin: 0;
    font-size: 10px;
    color: var(--text-muted);
  }

  .node-card {
    position: absolute;
    top: 20px;
    right: 20px;
    width: 240px;
    background: var(--bg-tertiary);
    border: 1px solid var(--line-light);
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    animation: fade-in 0.25s ease;
  }

  .node-cluster {
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .node-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 500;
    color: var(--text-primary);
    margin: 6px 0 8px;
  }

  .node-desc {
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
    margin: 0 0 12px;
  }

  .node-link {
    font-size: 11px;
    color: var(--accent);
    text-decoration: none;
  }

  .node-link:hover {
    text-decoration: underline;
  }

  @keyframes fade-in {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
