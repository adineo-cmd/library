import { describe, it, expect } from 'vitest';
import { loadConcepts, loadCrosslinks, parseLayout, slugify } from '../load';

const validNode = { id: 'physics', name: 'Physics', parent: -1, depth: 0, articleCount: 482913, aliases: [] };

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('History of Physics')).toBe('history-of-physics');
  });
  it('strips punctuation and collapses whitespace', () => {
    expect(slugify('  Physics: An  Introduction! ')).toBe('physics-an-introduction');
  });
  it('transliterates accents', () => {
    expect(slugify('Théorie des Jeux')).toBe('theorie-des-jeux');
  });
  it('drops characters with no URL-safe form', () => {
    expect(slugify('A / B (C)')).toBe('a-b-c');
  });
});

describe('loadConcepts', () => {
  const valid = { version: '1', dumpDate: '2026-08-05', nodeCount: 1, nodes: [validNode] };

  it('accepts a well-formed file', () => {
    expect(loadConcepts(valid).nodes[0].name).toBe('Physics');
  });
  it('throws when nodes is empty', () => {
    expect(() => loadConcepts({ ...valid, nodeCount: 0, nodes: [] })).toThrow(/nodeCount/i);
  });
  it('throws when nodeCount disagrees with nodes.length', () => {
    expect(() => loadConcepts({ ...valid, nodeCount: 5 })).toThrow(/nodeCount 5 != nodes\.length 1/);
  });
  it('throws when a parent index is out of range', () => {
    expect(() => loadConcepts({ ...valid, nodes: [{ ...validNode, parent: 99 }] })).toThrow(/parent/i);
  });
  it('throws when depth exceeds 5', () => {
    expect(() => loadConcepts({ ...valid, nodes: [{ ...validNode, depth: 6 }] })).toThrow(/depth/i);
  });
  it('throws on duplicate ids', () => {
    expect(() => loadConcepts({ ...valid, nodeCount: 2, nodes: [validNode, { ...validNode, parent: 0 }] }))
      .toThrow(/duplicate/i);
  });
  it('throws when a node is its own parent', () => {
    expect(() => loadConcepts({ ...valid, nodes: [{ ...validNode, parent: 0 }] })).toThrow(/parent/i);
  });
});

describe('loadCrosslinks', () => {
  it('accepts a well-formed file', () => {
    expect(loadCrosslinks({ edges: [{ a: 0, b: 1, shared: 4 }] }).edges).toHaveLength(1);
  });
  it('throws when a >= b, breaking undirected deduplication', () => {
    expect(() => loadCrosslinks({ edges: [{ a: 5, b: 2, shared: 4 }] })).toThrow(/a < b|unordered/i);
  });
  it('throws on a duplicate pair', () => {
    expect(() => loadCrosslinks({ edges: [{ a: 0, b: 1, shared: 4 }, { a: 0, b: 1, shared: 3 }] }))
      .toThrow(/duplicate/i);
  });
});

describe('parseLayout', () => {
  const build = (nodeCount: number, rootCount: number, crosslinkCount: number) =>
    new ArrayBuffer(nodeCount * 8 + (nodeCount - rootCount) * 4 + crosslinkCount * 8);

  const LAYOUT_BYTES = 3 * 8 + 2 * 4 + 1 * 8;

  const packed = () => {
    const buf = new ArrayBuffer(LAYOUT_BYTES);
    new Float32Array(buf, 0, 3).set([1, 2, 3]);
    new Float32Array(buf, 12, 3).set([4, 5, 6]);
    new Uint16Array(buf, 24, 2).set([0, 1]);
    new Uint16Array(buf, 28, 2).set([1, 2]);
    new Uint16Array(buf, 32, 1).set([0]);
    new Uint16Array(buf, 34, 1).set([2]);
    new Float32Array(buf, 36, 1).set([7]);
    return buf;
  };

  it('returns arrays matching the node and crosslink counts', () => {
    const l = parseLayout(build(3, 1, 1), 3, 1, 1);
    expect(l.x).toBeInstanceOf(Float32Array);
    expect(l.x).toHaveLength(3);
    expect(l.treeSrc).toHaveLength(2);
    expect(l.crossSrc).toHaveLength(1);
    expect(l.crossWeight).toHaveLength(1);
  });
  it('throws when the buffer is shorter than the declared layout', () => {
    expect(() => parseLayout(new ArrayBuffer(8), 3, 1, 0)).toThrow(/truncated|layout/i);
  });
  it('throws when the node count exceeds the Uint16 index limit', () => {
    expect(() => parseLayout(new ArrayBuffer(4), 70_000, 1, 0)).toThrow(/65535|Uint16/i);
  });
  it('sizes the tree sections by roots, so a forest decodes', () => {
    const l = parseLayout(build(4, 2, 1), 4, 2, 1);
    expect(l.x).toHaveLength(4);
    expect(l.treeSrc).toHaveLength(2);
    expect(l.treeDst).toHaveLength(2);
    expect(l.crossSrc).toHaveLength(1);
  });
  it('throws when rootCount is below 1 or above nodeCount', () => {
    expect(() => parseLayout(build(3, 1, 0), 3, 0, 0)).toThrow(/rootCount/i);
    expect(() => parseLayout(build(3, 1, 0), 3, 4, 0)).toThrow(/rootCount/i);
  });
  it('reads each section from its own offset, in spec 4.5 order', () => {
    const l = parseLayout(packed(), 3, 1, 1);
    expect([...l.x]).toEqual([1, 2, 3]);
    expect([...l.y]).toEqual([4, 5, 6]);
    expect([...l.treeSrc]).toEqual([0, 1]);
    expect([...l.treeDst]).toEqual([1, 2]);
    expect([...l.crossSrc]).toEqual([0]);
    expect([...l.crossDst]).toEqual([2]);
    expect([...l.crossWeight]).toEqual([7]);
  });
  it('decodes an ArrayBufferView, whose bytes may sit at a non-zero byteOffset', () => {
    const backing = new ArrayBuffer(LAYOUT_BYTES + 16);
    const view = new Uint8Array(backing, 16, LAYOUT_BYTES);
    view.set(new Uint8Array(packed()));
    expect(view.byteOffset).toBe(16);
    const direct = parseLayout(view, 3, 1, 1);
    const sliced = parseLayout(backing.slice(16, 16 + LAYOUT_BYTES), 3, 1, 1);
    expect([...direct.x]).toEqual([1, 2, 3]);
    expect([...direct.crossWeight]).toEqual([7]);
    expect([...sliced.x]).toEqual([1, 2, 3]);
    expect([...sliced.crossWeight]).toEqual([7]);
  });
});