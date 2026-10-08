import { z } from 'zod';

// --- Link Schema ---
export const LinkSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  type: z.enum(['course', 'paper', 'tool', 'community', 'reference', 'tutorial', 'book']),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  last_verified: z.string().datetime().optional(),
});

export type Link = z.infer<typeof LinkSchema>;

// --- OSINT/Radial Map Node Schema ---
export const RadialNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  parent: z.string().nullable(),
  description: z.string().min(1),
  links: z.array(LinkSchema).default([]),
});

export type RadialNode = z.infer<typeof RadialNodeSchema>;

// --- Roadmap Step Schema ---
export const RoadmapStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  next: z.array(z.string()).default([]),
  estimated_time: z.string().optional(),
  links: z.array(LinkSchema).default([]),
});

export type RoadmapStep = z.infer<typeof RoadmapStepSchema>;

// --- Tab Schemas ---
export const RadialTabSchema = z.object({
  structure: z.literal('tree'),
  nodes: z.array(RadialNodeSchema),
});

export const TraditionalTabSchema = z.object({
  content_type: z.literal('markdown'),
  body: z.string(),
  links: z.array(LinkSchema).default([]),
});

export const RoadmapTabSchema = z.object({
  type: z.enum(['linear', 'branching']),
  steps: z.array(RoadmapStepSchema),
});

// --- Metadata Schema ---
export const TopicMetadataSchema = z.object({
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  prerequisites: z.array(z.string()).default([]),
  related_topics: z.array(z.string()).default([]),
  domain_tags: z.array(z.string()),
  last_updated: z.string().datetime(),
  version: z.string(),
});

export type TopicMetadata = z.infer<typeof TopicMetadataSchema>;

// --- Main Topic Schema ---
export const TopicSchema = z.object({
  topic_id: z.string(),
  title: z.string(),
  short_description: z.string(),
  tabs: z.object({
    radial: RadialTabSchema,
    traditional: TraditionalTabSchema,
    roadmap: RoadmapTabSchema,
  }),
  metadata: TopicMetadataSchema,
});

export type Topic = z.infer<typeof TopicSchema>;

// --- Graph Data Types ---
export interface GraphNode {
  id: string;
  title: string;
  description: string;
  domain_tags: string[];
  difficulty: string;
  node_size: number;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship_type: 'related' | 'prerequisite' | 'both';
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphEdge[];
}