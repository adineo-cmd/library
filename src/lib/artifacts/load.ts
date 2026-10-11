import { conceptsFileSchema, crosslinksFileSchema, metaSchema, MAX_NODES } from './schemas';
import type {
  ConceptsFile, CrosslinksFile, LayoutArrays, Concept, CrossLink, Meta,
} from './types';

export { slugify } from '../../../scripts/lib/slug.mjs';

export function loadConcepts(raw: unknown): ConceptsFile {
  return conceptsFileSchema.parse(raw);
}

export function loadCrosslinks(raw: unknown): CrosslinksFile {
  return crosslinksFileSchema.parse(raw);
}

export function loadMeta(raw: unknown): Meta {
  return metaSchema.parse(raw);
}

/**
 * Decompose the packed layout buffer. Section order and widths are fixed by
 * spec section 4.5; any size mismatch is corruption and must throw. The format
 * has no header, so the tree-edge count comes from the caller: the atlas is a
 * forest, and a forest with `rootCount` roots has `nodeCount - rootCount` edges.
 */
export function parseLayout(
  buf: ArrayBuffer | ArrayBufferView,
  nodeCount: number,
  rootCount: number,
  crosslinkCount: number,
): LayoutArrays {
  if (nodeCount > MAX_NODES) {
    throw new Error(`layout: nodeCount ${nodeCount} exceeds the Uint16 index limit of ${MAX_NODES}`);
  }
  if (rootCount < 1 || rootCount > nodeCount) {
    throw new Error(
      `layout: rootCount ${rootCount} is out of range for ${nodeCount} nodes; ` +
      `every forest has at least 1 root and at most one per node`,
    );
  }
  // A view's bytes may sit at a non-zero byteOffset inside a larger (and for a
  // pooled Buffer, possibly unaligned) ArrayBuffer; copy it to offset 0.
  const bytes = ArrayBuffer.isView(buf)
    ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    : buf;
  const treeEdges = nodeCount - rootCount;
  const required = nodeCount * 8 + treeEdges * 4 + crosslinkCount * 8;
  if (bytes.byteLength !== required) {
    throw new Error(
      `layout truncated: expected ${required} bytes for ${nodeCount} nodes ` +
      `(${treeEdges} tree edges at ${rootCount} roots) / ` +
      `${crosslinkCount} crosslinks, got ${bytes.byteLength}`,
    );
  }
  let offset = 0;
  const take = <T extends Float32Array | Uint16Array>(Type: new (b: ArrayBufferLike, o: number, n: number) => T, n: number): T => {
    const view = new Type(bytes, offset, n);
    offset += view.byteLength;
    return view;
  };
  return {
    x: take(Float32Array, nodeCount),
    y: take(Float32Array, nodeCount),
    treeSrc: take(Uint16Array, treeEdges),
    treeDst: take(Uint16Array, treeEdges),
    crossSrc: take(Uint16Array, crosslinkCount),
    crossDst: take(Uint16Array, crosslinkCount),
    crossWeight: take(Float32Array, crosslinkCount),
  };
}

export type { Concept, CrossLink, LayoutArrays, Meta, ConceptsFile, CrosslinksFile };