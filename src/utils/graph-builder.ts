import { getTopics, calculateContentDepth } from './content-loader';
import type { GraphData, GraphNode, GraphEdge } from './types';

/**
 * Generate the global knowledge graph from all topics
 * This creates nodes and edges based on related_topics and prerequisites
 */
export async function generateGraphData(): Promise<GraphData> {
  const topics = await getTopics();
  
  const nodes: GraphNode[] = topics.map(topic => ({
    id: topic.topic_id,
    title: topic.title,
    description: topic.short_description,
    domain_tags: topic.metadata.domain_tags,
    difficulty: topic.metadata.difficulty,
    node_size: calculateContentDepth(topic),
  }));
  
  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>(); // Prevent duplicate edges
  
  topics.forEach(topic => {
    // Add related_topics edges
    topic.metadata.related_topics.forEach(relatedId => {
      const edgeKey = createEdgeKey(topic.topic_id, relatedId);
      
      if (!edgeSet.has(edgeKey)) {
        edges.push({
          source: topic.topic_id,
          target: relatedId,
          relationship_type: 'related',
          strength: 1,
        });
        edgeSet.add(edgeKey);
      }
    });
    
    // Add prerequisites edges (stronger connection)
    topic.metadata.prerequisites.forEach(prereqId => {
      const edgeKey = createEdgeKey(prereqId, topic.topic_id);
      
      // Check if this edge already exists as a different type
      const existingEdge = edges.find(e => 
        e.source === prereqId && e.target === topic.topic_id
      );
      
      if (existingEdge) {
        // Upgrade to 'both' if it was just 'related'
        existingEdge.relationship_type = 'both';
        existingEdge.strength = 3;
      } else if (!edgeSet.has(edgeKey)) {
        edges.push({
          source: prereqId,
          target: topic.topic_id,
          relationship_type: 'prerequisite',
          strength: 2,
        });
        edgeSet.add(edgeKey);
      }
    });
  });
  
  return {
    nodes,
    links: edges, // Using 'links' to match D3/Cytoscape convention
  };
}

/**
 * Create a unique key for an edge (undirected)
 */
function createEdgeKey(source: string, target: string): string {
  return [source, target].sort().join('->');
}

/**
 * Get domain color for graph visualization
 */
export function getDomainColor(domain: string): string {
  const colors: Record<string, string> = {
    'ai': '#3b82f6',        // Blue
    'ml': '#3b82f6',        // Blue
    'machine-learning': '#3b82f6',
    'ethics': '#10b981',    // Green
    'philosophy': '#10b981',
    'history': '#f59e0b',   // Amber
    'science': '#8b5cf6',   // Violet
    'physics': '#8b5cf6',
    'biology': '#10b981',
    'technology': '#ef4444', // Red
    'engineering': '#ef4444',
    'mathematics': '#06b6d4', // Cyan
    'psychology': '#ec4899', // Pink
    'neuroscience': '#ec4899',
    'computer-science': '#6366f1', // Indigo
    'data-science': '#14b8a6', // Teal
  };
  
  return colors[domain.toLowerCase()] || '#6b7280'; // Default gray
}

/**
 * Get difficulty color
 */
export function getDifficultyColor(difficulty: string): string {
  switch (difficulty) {
    case 'beginner':
      return '#22c55e'; // Green
    case 'intermediate':
      return '#eab308'; // Yellow
    case 'advanced':
      return '#ef4444'; // Red
    default:
      return '#6b7280'; // Gray
  }
}