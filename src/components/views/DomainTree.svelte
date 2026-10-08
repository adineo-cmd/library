<script>
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';

  let { domains } = $props();
  let container = $state(null);
  let svg = $state(null);

  onMount(() => {
    // SSR Safety check
    if (typeof window === 'undefined') return;
    if (!container || !domains) return;
    
    drawTree();
    window.addEventListener('resize', drawTree);
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('resize', drawTree);
    if (svg && container) d3.select(container).selectAll('*').remove();
  });

  function drawTree() {
    if (!container || typeof window === 'undefined') return;
    
    d3.select(container).selectAll('*').remove();
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    const rootX = 80;
    const rootY = height / 2;

    const defs = svg.append('defs');
    const gradient = defs.append('radialGradient')
      .attr('id', 'rootGlow')
      .attr('cx', '50%')
      .attr('cy', '50%')
      .attr('r', '50%');
    
    gradient.append('stop').attr('offset', '0%').attr('stop-color', '#d4a574').attr('stop-opacity', 0.4);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', '#d4a574').attr('stop-opacity', 0);

    svg.append('circle')
      .attr('cx', rootX)
      .attr('cy', rootY)
      .attr('r', 120)
      .attr('fill', 'url(#rootGlow)');

    svg.append('circle')
      .attr('cx', rootX)
      .attr('cy', rootY)
      .attr('r', 8)
      .attr('fill', '#d4a574');

    svg.append('text')
      .attr('x', rootX + 20)
      .attr('y', rootY + 5)
      .attr('fill', '#e8e4d9')
      .attr('font-family', 'Cormorant Garamond, serif')
      .attr('font-size', '20px')
      .attr('font-style', 'italic')
      .text('Arbor Root');

    const listX = width - 150;
    const spacing = height / (domains.length + 1);

    const domainData = domains.map((d, i) => ({
      ...d,
      y: spacing * (i + 1),
      x: listX
    }));

    svg.selectAll('.link')
      .data(domainData)
      .enter()
      .append('path')
      .attr('class', 'link')
      .attr('d', d => {
        const midX = rootX + (d.x - rootX) * 0.6;
        return `M ${rootX} ${rootY} C ${midX} ${rootY}, ${midX} ${d.y}, ${d.x} ${d.y}`;
      })
      .attr('fill', 'none')
      .attr('stroke', '#2a2a2a')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.8)
      .style('transition', 'stroke 0.3s ease');

    const listGroup = svg.append('g').attr('class', 'domain-list');

    const items = listGroup.selectAll('.domain-item')
      .data(domainData)
      .enter()
      .append('g')
      .attr('class', 'domain-item')
      .attr('transform', d => `translate(${d.x}, ${d.y})`)
      .style('cursor', 'pointer');

    items.append('text')
      .attr('x', -60)
      .attr('y', 5)
      .attr('fill', '#555555')
      .attr('font-size', '11px')
      .attr('font-family', 'Inter, sans-serif')
      .text(d => d.id);

    items.append('text')
      .attr('x', -40)
      .attr('y', 5)
      .attr('fill', '#888888')
      .attr('font-size', '13px')
      .attr('font-family', 'Inter, sans-serif')
      .text(d => d.label)
      .style('transition', 'fill 0.3s ease');

    items.append('circle')
      .attr('cx', 0)
      .attr('cy', 0)
      .attr('r', 5)
      .attr('fill', 'none')
      .attr('stroke', '#555555')
      .attr('stroke-width', 1.5)
      .style('transition', 'all 0.3s ease');

    items.on('mouseenter', function(event, d) {
      d3.select(this).select('text:nth-child(2)').attr('fill', '#d4a574');
      d3.select(this).select('circle').attr('stroke', '#d4a574').attr('r', 7);
      
      svg.selectAll('.link')
        .filter(link => link.id === d.id)
        .attr('stroke', '#d4a574')
        .attr('stroke-width', 2);
    });

    items.on('mouseleave', function(event, d) {
      d3.select(this).select('text:nth-child(2)').attr('fill', '#888888');
      d3.select(this).select('circle').attr('stroke', '#555555').attr('r', 5);
      
      svg.selectAll('.link')
        .filter(link => link.id === d.id)
        .attr('stroke', '#2a2a2a')
        .attr('stroke-width', 1.5);
    });
  }
</script>

<div class="tree-wrapper" bind:this={container}></div>

<style>
  .tree-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
  }
  
  .domain-item {
    transition: transform 0.3s ease;
  }
  
  .domain-item:hover {
    transform: translateX(-5px);
  }
</style>