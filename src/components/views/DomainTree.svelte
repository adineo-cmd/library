<script>
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';

  let { domains } = $props();
  let container = $state(null);
  let svg = $state(null);

  // Trunk colours — one hue per main domain so the atlas reads at a glance.
  const trunkPalette = [
    '#2dd4bf', // sciences
    '#60a5fa', // formal
    '#a78bfa', // social
    '#d4a574', // humanities
    '#f87171', // arts
    '#34d399', // health
    '#fbbf24', // law
    '#94a3b8'  // engineering
  ];

  onMount(() => {
    if (typeof window === 'undefined') return;
    if (!container || !domains) return;

    drawTree();
    window.addEventListener('resize', handleResize);

    const searchInput = document.getElementById('domainSearch');
    if (searchInput) searchInput.addEventListener('input', handleSearch);
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('resize', handleResize);
    const searchInput = document.getElementById('domainSearch');
    if (searchInput) searchInput.removeEventListener('input', handleSearch);
    if (svg && container) d3.select(container).selectAll('*').remove();
  });

  let currentDomains = $state([]);

  function handleResize() {
    drawTree(currentDomains.length ? currentDomains : domains);
  }

  function handleSearch(e) {
    const query = e.target.value.toLowerCase().trim();
    const filtered = query
      ? domains.filter((d) => d.label.toLowerCase().includes(query))
      : domains;
    currentDomains = filtered;
    drawTree(filtered);
  }

  function drawTree(list = domains) {
    if (!container || typeof window === 'undefined') return;

    d3.select(container).selectAll('*').remove();

    const width = container.clientWidth;
    const height = Math.max(container.clientHeight, list.length * 70 + 80);

    svg = d3
      .select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    const rootX = 90;
    const rootY = height / 2;

    // Soft glow behind the root
    const defs = svg.append('defs');
    const gradient = defs
      .append('radialGradient')
      .attr('id', 'rootGlow')
      .attr('cx', '50%')
      .attr('cy', '50%')
      .attr('r', '50%');
    gradient.append('stop').attr('offset', '0%').attr('stop-color', '#d4a574').attr('stop-opacity', 0.4);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', '#d4a574').attr('stop-opacity', 0);

    svg
      .append('circle')
      .attr('cx', rootX)
      .attr('cy', rootY)
      .attr('r', 120)
      .attr('fill', 'url(#rootGlow)')
      .style('pointer-events', 'none');

    svg.append('circle').attr('cx', rootX).attr('cy', rootY).attr('r', 8).attr('fill', '#d4a574');

    svg
      .append('text')
      .attr('x', rootX + 20)
      .attr('y', rootY + 5)
      .attr('fill', '#e8e4d9')
      .attr('font-family', 'Cormorant Garamond, serif')
      .attr('font-size', '20px')
      .attr('font-style', 'italic')
      .text('Arbor Root');

    const spacing = (height - 80) / (list.length + 1);
    const domainData = list.map((d, i) => ({
      ...d,
      y: 40 + spacing * (i + 1),
      x: width - 170,
      color: trunkPalette[i % trunkPalette.length],
    }));

    // Branch paths (drawn first, under everything)
    const links = svg
      .selectAll('.link')
      .data(domainData)
      .enter()
      .append('path')
      .attr('class', 'link')
      .attr('d', (d) => {
        const midX = rootX + (d.x - rootX) * 0.6;
        return `M ${rootX} ${rootY} C ${midX} ${rootY}, ${midX} ${d.y}, ${d.x} ${d.y}`;
      })
      .attr('fill', 'none')
      .attr('stroke', '#2a2a2a')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.85);

    // Draw-in animation for branches
    links.each(function () {
      const len = this.getTotalLength();
      d3.select(this)
        .attr('stroke-dasharray', `${len} ${len}`)
        .attr('stroke-dashoffset', len)
        .transition()
        .duration(900)
        .delay((d, i) => i * 80)
        .ease(d3.easeCubicOut)
        .attr('stroke-dashoffset', 0)
        .on('end', function () {
          d3.select(this).attr('stroke-dasharray', null);
        });
    });

    const items = svg
      .append('g')
      .selectAll('.domain-item')
      .data(domainData)
      .enter()
      .append('g')
      .attr('class', 'domain-item')
      .attr('transform', (d) => `translate(${d.x}, ${d.y})`)
      .style('cursor', 'pointer')
      // Clicking a trunk drops you into the explorer with that branch open.
      .on('click', (event, d) => {
        window.location.href = `/domains?open=${encodeURIComponent(d.label)}`;
      });

    items
      .append('text')
      .attr('x', -78)
      .attr('y', 4)
      .attr('fill', '#555555')
      .attr('font-size', '11px')
      .attr('font-family', 'Inter, sans-serif')
      .text((d) => d.id);

    items
      .append('text')
      .attr('class', 'trunk-label')
      .attr('x', -58)
      .attr('y', 4)
      .attr('fill', '#888888')
      .attr('font-size', '13px')
      .attr('font-family', 'Inter, sans-serif')
      .text((d) => d.label);

    items
      .append('text')
      .attr('class', 'trunk-count')
      .attr('x', 16)
      .attr('y', 4)
      .attr('fill', '#555555')
      .attr('font-size', '10px')
      .attr('letter-spacing', '0.08em')
      .attr('font-family', 'Inter, sans-serif')
      .text((d) => (d.count ? `${d.count}` : ''));

    items
      .append('circle')
      .attr('r', 5)
      .attr('fill', 'none')
      .attr('stroke', '#555555')
      .attr('stroke-width', 1.5);

    items.on('mouseenter', function (event, d) {
      d3.select(this).select('.trunk-label').attr('fill', d.color);
      d3.select(this).select('circle').attr('stroke', d.color).attr('r', 7).attr('fill', d.color).attr('fill-opacity', 0.25);
      links
        .filter((l) => l.id === d.id)
        .attr('stroke', d.color)
        .attr('stroke-width', 2);
    });

    items.on('mouseleave', function (event, d) {
      d3.select(this).select('.trunk-label').attr('fill', '#888888');
      d3.select(this).select('circle').attr('stroke', '#555555').attr('r', 5).attr('fill', 'none');
      links.filter((l) => l.id === d.id).attr('stroke', '#2a2a2a').attr('stroke-width', 1.5);
    });
  }
</script>

<div class="tree-wrapper" bind:this={container}></div>

<style>
  .tree-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: #2a2a2a transparent;
  }

  .domain-item {
    transition: transform 0.3s ease;
  }

  .domain-item:hover {
    transform: translateX(-5px);
  }
</style>
