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
 * spec section 4.5; any size mismatch is corruption and must throw.
 */
export function parseLayout(
  buf: ArrayBuffer | ArrayBufferView,
  nodeCount: number,
  crosslinkCount: number,
): LayoutArrays {
  if (nodeCount > MAX_NODES) {
    throw new Error(`layout: nodeCount ${nodeCount} exceeds the Uint16 index limit of ${MAX_NODES}`);
  }
  // A view's bytes may sit at a non-zero byteOffset inside a larger (and for a
  // pooled Buffer, possibly unaligned) ArrayBuffer; copy it to offset 0.
  const bytes = ArrayBuffer.isView(buf)
    ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    : buf;
  const treeEdges = nodeCount - 1;
  const required = nodeCount * 8 + treeEdges * 4 + crosslinkCount * 8;
  if (bytes.byteLength !== required) {
    throw new Error(
      `layout truncated: expected ${required} bytes for ${nodeCount} nodes / ` +
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