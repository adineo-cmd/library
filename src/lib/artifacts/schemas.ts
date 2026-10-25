import { z } from 'zod';

export const MAX_DEPTH = 5;
export const MAX_NODES = 65_535;

const conceptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parent: z.number().int(),
  depth: z.number().int().min(0).max(MAX_DEPTH),
  articleCount: z.number().int().min(0),
  aliases: z.array(z.string()),
});

export const conceptsFileSchema = z.object({
  version: z.string(),
  dumpDate: z.string().nullable(),
  nodeCount: z.number().int().positive(),
  nodes: z.array(conceptSchema).min(1),
}).superRefine((file, ctx) => {
  if (file.nodes.length !== file.nodeCount) {
    ctx.addIssue({ code: 'custom', message: `nodeCount ${file.nodeCount} != nodes.length ${file.nodes.length}` });
  }
  const seen = new Set<string>();
  file.nodes.forEach((n, i) => {
    if (seen.has(n.id)) ctx.addIssue({ code: 'custom', message: `duplicate id "${n.id}" at index ${i}` });
    seen.add(n.id);
    if (n.parent >= file.nodes.length) ctx.addIssue({ code: 'custom', message: `node ${i} parent ${n.parent} is out of range` });
    if (n.parent === i) ctx.addIssue({ code: 'custom', message: `node ${i} is its own parent` });
  });
});

const crossLinkSchema = z.object({
  a: z.number().int(), b: z.number().int(), shared: z.number().int().min(1),
}).refine(e => e.a < e.b, { message: 'crosslinks must be unordered: a < b' });

export const crosslinksFileSchema = z.object({
  edges: z.array(crossLinkSchema).superRefine((edges, ctx) => {
    const seen = new Set<string>();
    edges.forEach((e, i) => {
      const key = `${e.a}-${e.b}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate pair ${key} at index ${i}` });
      seen.add(key);
    });
  }),
});

export const methodParamsSchema = z.object({
  nodeTarget: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  crosslinkMinArticleCount: z.number().int().min(0),
  crosslinkMinShared: z.number().int().min(1),
  crosslinkTopK: z.number().int().min(1),
  crosslinkGlobalCap: z.number().int().min(1),
  crosslinkMemberSample: z.number().int().min(1),
  metaFilterPatterns: z.array(z.string()),
});

export const metaSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  dumpDate: z.string().nullable(),
  counts: z.object({
    rawCategories: z.number().int().nonnegative(),
    afterMetaFilter: z.number().int().nonnegative(),
    afterDepthCap: z.number().int().nonnegative(),
    finalNodes: z.number().int().nonnegative(),
    restoredAncestors: z.number().int().nonnegative(),
    crosslinks: z.number().int().nonnegative(),
    danglingCrosslinks: z.number().int().nonnegative(),
  }),
  params: methodParamsSchema,
  sources: z.array(z.object({ name: z.string(), url: z.string(), license: z.string() })),
});