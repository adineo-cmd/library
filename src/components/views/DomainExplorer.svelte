<script>
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import treeData from '../../data/Domain/domains.json';

  let container = $state(null);
  let svg = $state(null);
  let zoomBehavior = $state(null);
  let root = $state(null);
  let i = 0;
  const duration = 750;
  let allSearchNodes = [];
  let searchMatches = [];

  // Design System Colors
  const colorAccent = '#d4a574';
  const colorTextPrimary = '#e8e4d9';
  const colorTextSecondary = '#888888';
  const colorNodeStroke = '#555555';
  const colorLink = '#1a1a1a';

  onMount(() => {
    if (typeof window === 'undefined') return;
    if (!container) return;
    
    drawTree();
    window.addEventListener('resize', handleResize);
    
    const searchInput = document.getElementById('domainSearch');
    if (searchInput) {
      searchInput.addEventListener('input', handleSearch);
    }
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('resize', handleResize);
    const searchInput = document.getElementById('domainSearch');
    if (searchInput) {
      searchInput.removeEventListener('input', handleSearch);
    }
    if (svg && container) d3.select(container).selectAll('*').remove();
  });

  function handleResize() {
    drawTree();
  }

  function handleSearch(e) {
    const query = e.target.value.toLowerCase().trim();
    if (!svg || !root) return;

    // Clear previous highlights
    root.descendants().forEach(n => { n._highlighted = false; });

    if (!query) {
      searchMatches = [];
      // Collapse back to root when search is cleared
      if (root.children) root.children.forEach(collapse);
      update(root);
      return;
    }

    // Find matches
    searchMatches = allSearchNodes.filter(d => {
      const name = (d.data.name || "").toLowerCase();
      return name.includes(query);
    });

    if (searchMatches.length > 0) {
      // Auto-expand ancestors of all matched nodes
      searchMatches.forEach(d => {
        d.ancestors().forEach(ancestor => {
          if (ancestor._children) {
            ancestor.children = ancestor._children;
            ancestor._children = null;
          }
        });
        d._highlighted = true;
      });
    }
    
    update(root);
    
    // Smooth pan to the first match
    if (searchMatches.length > 0) {
      zoomToNode(searchMatches[0]);
    }
  }

  function collapse(d) {
    if (d.children) {
      d._children = d.children;
      d._children.forEach(collapse);
      d.children = null;
    }
  }

  function drawTree() {
    if (!container) return;
    d3.select(container).selectAll('*').remove();

    const width = container.clientWidth;
    const height = container.clientHeight;
    const margin = { top: 40, right: 150, bottom: 40, left: 150 };

    svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`);

    // Defs for root glow
    const defs = svg.append('defs');
    const gradient = defs.append('radialGradient')
      .attr('id', 'rootGlowDetailed')
      .attr('cx', '50%')
      .attr('cy', '50%')
      .attr('r', '50%');
    
    gradient.append('stop').attr('offset', '0%').attr('stop-color', colorAccent).attr('stop-opacity', 0.4);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', colorAccent).attr('stop-opacity', 0);

    const vis = svg.append('g').attr('class', 'vis');

    // Zoom & Pan Behavior
    zoomBehavior = d3.zoom()
      .scaleExtent([0.1, 3])
      .on('zoom', (event) => {
        const t = event.transform;
        vis.attr('transform', `translate(${margin.left + t.x}, ${margin.top + t.y}) scale(${t.k})`);
      });
    
    svg.call(zoomBehavior);

    // Parse hierarchical data
    root = d3.hierarchy(treeData, d => d.children);
    root.x0 = 0;
    root.y0 = 0;

    // Collect all leaf nodes for search functionality
    allSearchNodes = root.descendants().filter(d => !d.children);

    // Collapse all children initially to showcase expand/collapse
    if (root.children) {
      root.children.forEach(collapse);
    }

    // Tree Layout (nodeSize: [vertical_spacing, horizontal_spacing])
    const tree = d3.tree().nodeSize([45, 180]);
    tree(root);

    // Auto-fit Viewport Calculation
    const visibleNodes = root.descendants();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    visibleNodes.forEach(d => {
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
    });

    const pad = 60;
    const bw = (maxY - minY) || 1;
    const bh = (maxX - minX) || 1;
    const k = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh, 1.5);
    const cy = (minX + maxX) / 2;
    
    const initialTx = pad;
    const initialTy = (height / 2) - (cy * k);

    svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(initialTx, initialTy).scale(k));

    // Root Glow (stays at 0,0 relative to vis group)
    vis.append('circle')
      .attr('class', 'root-glow')
      .attr('cx', 0)
      .attr('cy', 0)
      .attr('r', 120)
      .attr('fill', 'url(#rootGlowDetailed)')
      .style('pointer-events', 'none');

    update(root);
  }

  function update(source) {
    const tree = d3.tree().nodeSize([45, 180]);
    tree(root);
    
    const nodes = root.descendants().reverse();
    const links = root.links();
    const diagonal = d3.linkHorizontal().x(d => d.y).y(d => d.x);

    // --- NODES ---
    const node = svg.select('.vis').selectAll('g.node')
      .data(nodes, d => d.id || (d.id = ++i));

    // Enter
    const nodeEnter = node.enter().append('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${source.y0},${source.x0})`)
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        if (d.children) {
          d._children = d.children;
          d.children = null;
        } else {
          d.children = d._children;
          d._children = null;
        }
        update(d);
      });

    nodeEnter.append('circle')
      .attr('r', 1e-6)
      .attr('fill', d => d.depth === 0 ? colorAccent : 'none')
      .attr('stroke', d => d.depth === 0 ? 'none' : colorNodeStroke)
      .attr('stroke-width', d => d.depth === 0 ? 0 : 1.5);

    nodeEnter.append('text')
      .attr('dy', '.35em')
      .attr('x', d => d.depth === 0 ? 20 : 15)
      .attr('text-anchor', 'start')
      .attr('fill', d => d.depth === 0 ? colorTextPrimary : colorTextSecondary)
      .attr('font-family', d => d.depth === 0 ? 'Cormorant Garamond, serif' : 'Inter, sans-serif')
      .attr('font-size', d => d.depth === 0 ? '24px' : '14px')
      .attr('font-style', d => d.depth === 0 ? 'italic' : 'normal')
      .attr('opacity', 1e-6)
      .text(d => d.data.id ? `${d.data.id} ${d.data.name}` : d.data.name);

    // Update
    const nodeUpdate = node.merge(nodeEnter).transition().duration(duration)
      .attr('transform', d => `translate(${d.y},${d.x})`);

    nodeUpdate.select('circle')
      .attr('r', d => d.depth === 0 ? 8 : (d._highlighted ? 6 : 4))
      .attr('fill', d => d.depth === 0 ? colorAccent : 'none')
      .attr('stroke', d => d._highlighted ? colorAccent : (d.depth === 0 ? 'none' : colorNodeStroke))
      .attr('stroke-width', d => d.depth === 0 ? 0 : (d._highlighted ? 2.5 : 1.5));

    nodeUpdate.select('text')
      .attr('fill', d => d._highlighted ? colorAccent : (d.depth === 0 ? colorTextPrimary : colorTextSecondary))
      .attr('opacity', 1);

    // Exit
    const nodeExit = node.exit().transition().duration(duration)
      .attr('transform', d => `translate(${source.y},${source.x})`)
      .remove();

    nodeExit.select('circle').attr('r', 1e-6);
    nodeExit.select('text').attr('opacity', 1e-6);

    // --- LINKS ---
    const link = svg.select('.vis').selectAll('path.link')
      .data(links, d => d.target.id);

    const linkEnter = link.enter().insert('path', 'g.node')
      .attr('class', 'link')
      .attr('d', d => diagonal({ source: { x: source.x0, y: source.y0 }, target: { x: source.x0, y: source.y0 } }))
      .attr('fill', 'none')
      .attr('stroke', colorLink)
      .attr('stroke-width', 1)
      .attr('opacity', 0.8);

    linkEnter.transition().duration(duration)
      .attr('d', diagonal);

    link.merge(linkEnter).transition().duration(duration)
      .attr('d', diagonal)
      .attr('class', d => d.target._highlighted ? 'link highlighted' : 'link')
      .attr('stroke', d => d.target._highlighted ? colorAccent : colorLink)
      .attr('stroke-width', d => d.target._highlighted ? 2 : 1);

    link.exit().transition().duration(duration)
      .attr('d', d => diagonal({ source: { x: source.x, y: source.y }, target: { x: source.x, y: source.y } }))
      .remove();

    // Stash old positions for smooth transitions
    nodes.forEach(d => {
      d.x0 = d.x;
      d.y0 = d.y;
    });
  }

  function zoomToNode(d) {
    if (!svg || !zoomBehavior) return;
    const currentK = d3.zoomTransform(svg.node()).k;
    const margin = { top: 40, right: 150, bottom: 40, left: 150 };
    const containerRect = container.getBoundingClientRect();
    
    const targetX = (containerRect.width / 2) - margin.left - (d.y * currentK);
    const targetY = (containerRect.height / 2) - margin.top - (d.x * currentK);
    
    svg.transition().duration(duration)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(targetX, targetY).scale(currentK));
  }
</script>

<div class="tree-wrapper" bind:this={container}></div>

<style>
  .tree-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
  }

  /* Smooth CSS transitions complementing D3 animations */
  .node circle {
    transition: all 0.3s ease;
  }
  .node text {
    transition: fill 0.3s ease;
  }
  .node:hover circle {
    stroke: #d4a574 !important;
    r: 6 !important;
  }
  .node:hover text {
    fill: #d4a574 !important;
  }
  .link {
    transition: stroke 0.3s ease, stroke-width 0.3s ease;
  }
</style>