export interface Concept {
  id: string;
  name: string;
  parent: number;
  depth: number;
  articleCount: number;
  aliases: string[];
}

export interface CrossLink {
  a: number;
  b: number;
  shared: number;
}

export interface ConceptsFile {
  version: string;
  dumpDate: string | null;
  nodeCount: number;
  nodes: Concept[];
}

export interface CrosslinksFile {
  edges: CrossLink[];
}

export interface LayoutArrays {
  x: Float32Array;
  y: Float32Array;
  treeSrc: Uint16Array;
  treeDst: Uint16Array;
  crossSrc: Uint16Array;
  crossDst: Uint16Array;
  crossWeight: Float32Array;
}

export interface MethodParams {
  nodeTarget: number;
  maxDepth: number;
  crosslinkMinArticleCount: number;
  crosslinkMinShared: number;
  crosslinkTopK: number;
  crosslinkGlobalCap: number;
  crosslinkMemberSample: number;
  metaFilterPatterns: string[];
}

export interface Meta {
  version: string;
  generatedAt: string;
  dumpDate: string | null;
  counts: Record<string, number>;
  params: MethodParams;
  sources: { name: string; url: string; license: string }[];
}