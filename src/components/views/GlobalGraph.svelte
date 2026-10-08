<script>
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';

  let { nodes = [], links = [] } = $props();
  let container = $state(null);
  let simulation = $state(null);

  const clusterColors = {
    'Sciences': '#2dd4bf',
    'Humanities': '#d4a574',
    'Formal Systems': '#60a5fa',
    'Arts': '#f87171',
    'Applied': '#a78bfa'
  };

  onMount(() => {
    if (typeof window === 'undefined') return; // ADD THIS
    if (!container || nodes.length === 0) return;
    initGraph();
    window.addEventListener('resize', handleResize);
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return; // ADD THIS
    window.removeEventListener('resize', handleResize);
    if (simulation) simulation.stop();
    if (container) d3.select(container).selectAll('*').remove();
  });

  function handleResize() {
    if (typeof window === 'undefined') return; // ADD THIS
    if (container) initGraph();
  }

  function initGraph() {
    if (!container) return;
    d3.select(container).selectAll('*').remove();

    const width = container.clientWidth;
    const height = container.clientHeight;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    // Add zoom behavior
    const g = svg.append('g');
    const zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    svg.call(zoom);

    // Setup simulation
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius(d => d.size * 1.5));

    // Draw links
    const link = g.append('g')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke', '#2a2a2a')
      .attr('stroke-width', 1)
      .attr('opacity', 0.6);

    // Draw nodes (with glow effect)
    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .call(d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));

    // Glow circle
    node.append('circle')
      .attr('r', d => d.size * 2.5)
      .attr('fill', d => clusterColors[d.cluster] || '#888')
      .attr('opacity', 0.15);

    // Core circle
    node.append('circle')
      .attr('r', d => d.size)
      .attr('fill', d => clusterColors[d.cluster] || '#888')
      .attr('stroke', '#0a0a0a')
      .attr('stroke-width', 1.5);

    // Update positions on tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node
        .attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // Drag functions
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

<div class="graph-canvas" bind:this={container}></div>

<style>
  .graph-canvas {
    width: 100%;
    height: 100%;
    background: #0f0f0f;
    border-radius: 8px;
    overflow: hidden;
    position: relative;
  }
</style>