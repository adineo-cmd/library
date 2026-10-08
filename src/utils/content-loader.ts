import { TopicSchema, type Topic } from './types';

/**
 * Load all topics from /src/data/topics/*.json
 * This runs at build time in Astro
 */
export async function getTopics(): Promise<Topic[]> {
  const topics: Topic[] = [];
  
  // In Astro, we can use import.meta.glob to import all JSON files
  const modules = import.meta.glob<{ default: Topic }>('/src/data/topics/*.json', { eager: true });
  
  for (const [path, module] of Object.entries(modules)) {
    try {
      const topic = module.default;
      
      // Validate with Zod
      const validatedTopic = TopicSchema.parse(topic);
      topics.push(validatedTopic);
      
    } catch (error) {
      console.error(`❌ Invalid topic in ${path}:`, error);
      // In production, you might want to throw here
      // throw new Error(`Invalid topic data in ${path}`);
    }
  }
  
  // Sort by title alphabetically
  return topics.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Get a single topic by its slug (topic_id)
 */
export async function getTopicBySlug(slug: string): Promise<Topic | undefined> {
  const topics = await getTopics();
  return topics.find(t => t.topic_id === slug);
}

/**
 * Get related topics for a given topic
 */
export async function getRelatedTopics(topic: Topic): Promise<Topic[]> {
  const allTopics = await getTopics();
  const relatedIds = topic.metadata.related_topics;
  
  return allTopics.filter(t => relatedIds.includes(t.topic_id));
}

/**
 * Calculate content depth for graph node sizing
 */
export function calculateContentDepth(topic: Topic): number {
  const radialNodes = topic.tabs.radial.nodes.length;
  const roadmapSteps = topic.tabs.roadmap.steps.length;
  const traditionalLength = topic.tabs.traditional.body.length;
  
  // Weighted calculation
  return 1 + (radialNodes * 2) + (roadmapSteps * 2) + Math.floor(traditionalLength / 500);
}

/**
 * Search topics by title, description, or tags
 */
export async function searchTopics(query: string): Promise<Topic[]> {
  const topics = await getTopics();
  const lowerQuery = query.toLowerCase();
  
  return topics.filter(t => 
    t.title.toLowerCase().includes(lowerQuery) ||
    t.short_description.toLowerCase().includes(lowerQuery) ||
    t.metadata.domain_tags.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
}