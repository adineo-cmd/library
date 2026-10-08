<script>
  let { data } = $props();
</script>

<div class="roadmap-container">
  <!-- Root Node -->
  <div class="root-node">{data.name}</div>
  
  <!-- Central Spine Line -->
  <div class="spine-line"></div>
  
  <!-- Categories -->
  {#each data.children as category, i}
    <div class="category-row" class:reverse={i % 2 !== 0}>
      
      <!-- Subtopics Stack (appears on left or right based on :reverse) -->
      <div class="subtopics-stack">
        {#each category.children as topic}
          <div class="topic-with-connector">
            <div class="topic-node" 
                 class:completed={topic.status === 'completed'} 
                 class:active={topic.status === 'active'} 
                 class:alternative={topic.variant === 'alternative'}>
              {topic.name}
              {#if topic.status === 'completed'}
                <span class="status-icon">✓</span>
              {:else if topic.status === 'active'}
                <span class="status-icon active-dot"></span>
              {/if}
            </div>
            <div class="connector-line"></div>
          </div>
        {/each}
      </div>

      <!-- Center: Category Node -->
      <div class="category-node-wrapper">
        <div class="category-node" 
             class:completed={category.status === 'completed'} 
             class:active={category.status === 'active'}>
          {category.name}
        </div>
      </div>

      <!-- Empty side for balance -->
      <div class="empty-side"></div>
    </div>
  {/each}
</div>

<style>
  .roadmap-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 60px 40px 100px;
    position: relative;
    background: #0f0f0f;
    color: #e8e4d9;
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    width: 100%;
    overflow-x: auto;
  }

  .root-node {
    background: #1a1a1a;
    border: 2px solid #d4a574;
    color: #d4a574;
    padding: 18px 48px;
    border-radius: 30px;
    font-size: 18px;
    font-weight: 600;
    z-index: 2;
    margin-bottom: 60px;
    box-shadow: 0 4px 20px rgba(212, 165, 116, 0.15);
  }

  .spine-line {
    position: absolute;
    top: 110px;
    bottom: 60px;
    left: 50%;
    width: 3px;
    background: #d4a574;
    transform: translateX(-50%);
    z-index: 1;
  }

  .category-row {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    width: 100%;
    max-width: 1400px;
    margin-bottom: 80px;
    position: relative;
    z-index: 2;
    gap: 0;
  }

  .category-row.reverse {
    /* Subtopics appear on right side */
  }

  .subtopics-stack {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 0 40px;
  }

  .category-row:not(.reverse) .subtopics-stack {
    justify-content: flex-end;
    align-items: flex-end;
  }

  .category-row.reverse .subtopics-stack {
    grid-column: 3;
    justify-content: flex-start;
    align-items: flex-start;
  }

  .category-row:not(.reverse) .empty-side {
    grid-column: 3;
  }

  .category-row.reverse .empty-side {
    grid-column: 1;
  }

  .category-node-wrapper {
    grid-column: 2;
    z-index: 3;
  }

  .topic-with-connector {
    display: flex;
    align-items: center;
    gap: 0;
  }

  .category-row:not(.reverse) .topic-with-connector {
    flex-direction: row;
  }

  .category-row.reverse .topic-with-connector {
    flex-direction: row-reverse;
  }

  .connector-line {
    width: 80px;
    height: 2px;
    background: #2a2a2a;
    flex-shrink: 0;
  }

  .category-node {
    background: #141414;
    border: 2px solid #d4a574;
    color: #e8e4d9;
    padding: 18px 36px;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    min-width: 220px;
    text-align: center;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    transition: transform 0.3s ease;
  }

  .category-node:hover {
    transform: scale(1.05);
  }

  .category-node.completed {
    border-color: #2dd4bf;
  }

  .category-node.active {
    border-color: #d4a574;
    box-shadow: 0 0 20px rgba(212, 165, 116, 0.3);
  }

  .topic-node {
    background: #141414;
    border: 1px solid #2a2a2a;
    color: #e8e4d9;
    padding: 14px 22px;
    border-radius: 8px;
    font-size: 13px;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    transition: all 0.3s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    min-width: 180px;
    max-width: 240px;
  }

  .topic-node:hover {
    border-color: #d4a574;
    background: #1a1a1a;
  }

  .topic-node.completed {
    border-color: #2dd4bf;
  }

  .topic-node.active {
    border-color: #d4a574;
  }

  .topic-node.alternative {
    border-style: dashed;
    border-color: #555;
    color: #a0a0a0;
  }

  .status-icon {
    font-size: 14px;
    flex-shrink: 0;
    color: #2dd4bf;
    font-weight: bold;
  }

  .active-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #d4a574;
    display: inline-block;
    box-shadow: 0 0 8px #d4a574;
  }

  @media (max-width: 900px) {
    .category-row {
      grid-template-columns: 1fr !important;
      gap: 20px;
    }
    
    .category-row.reverse .subtopics-stack,
    .category-row:not(.reverse) .subtopics-stack {
      grid-column: 1 !important;
      align-items: center !important;
      padding: 0;
    }
    
    .category-node-wrapper {
      grid-column: 1 !important;
    }
    
    .empty-side {
      display: none;
    }
    
    .connector-line {
      display: none;
    }
    
    .spine-line {
      display: none;
    }
  }
</style>