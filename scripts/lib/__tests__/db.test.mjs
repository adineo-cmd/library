import { describe, it, expect } from 'vitest';
import { openDb, assignStableIds, finalizeIndexes } from '../db.mjs';

describe('openDb', () => {
  it('creates the three ingest tables', () => {
    const db = openDb(':memory:');
    const names = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cat','parent','member')`,
    ).all().map(r => r.name).sort();
    expect(names).toEqual(['cat', 'member', 'parent']);
  });
});

describe('assignStableIds', () => {
  it('renumbers ids alphabetically so they do not depend on insert order', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Zebra');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Apple');
    assignStableIds(db);
    expect(db.prepare('SELECT id,name FROM cat ORDER BY id').all())
      .toEqual([{ id: 1, name: 'Apple' }, { id: 2, name: 'Zebra' }]);
  });

  it('remaps parent edges to the new ids', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Zebra');
    const child = db.prepare('SELECT id FROM cat WHERE name=?').get('Zebra').id;
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Apple');
    const parent = db.prepare('SELECT id FROM cat WHERE name=?').get('Apple').id;
    db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)').run(child, parent);
    assignStableIds(db);
    expect(db.prepare(
      'SELECT c.name AS child, p.name AS parent FROM parent e ' +
      'JOIN cat c ON c.id=e.child JOIN cat p ON p.id=e.parent',
    ).get()).toEqual({ child: 'Zebra', parent: 'Apple' });
  });

  it('remaps member rows to the new ids', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Zebra');
    const z = db.prepare('SELECT id FROM cat WHERE name=?').get('Zebra').id;
    db.prepare('INSERT INTO cat(name) VALUES (?)').run('Apple');
    const a = db.prepare('SELECT id FROM cat WHERE name=?').get('Apple').id;
    db.prepare('INSERT INTO member(article,cat) VALUES (?,?)').run('x', z);
    assignStableIds(db);
    expect(db.prepare(
      'SELECT m.article, c.name FROM member m JOIN cat c ON c.id=m.cat',
    ).get()).toEqual({ article: 'x', name: 'Zebra' });
    void a;
  });

  // The failure this guards against is silent: a child and its parent swap
  // places during renumbering and the whole category forest inverts.
  it('preserves edge direction across a chain whose ids all move', () => {
    const db = openDb(':memory:');
    const idOf = new Map();
    for (const name of ['Zebra', 'Apple', 'Mango']) {
      db.prepare('INSERT INTO cat(name) VALUES (?)').run(name);
      idOf.set(name, db.prepare('SELECT id FROM cat WHERE name=?').get(name).id);
    }
    // Zebra -> Apple -> Mango, written as child,parent.
    db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)').run(idOf.get('Zebra'), idOf.get('Apple'));
    db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)').run(idOf.get('Apple'), idOf.get('Mango'));

    assignStableIds(db);

    const ids = db.prepare('SELECT name,id FROM cat').all();
    expect(ids.find(r => r.name === 'Apple').id).toBe(1);
    expect(ids.find(r => r.name === 'Mango').id).toBe(2);
    expect(ids.find(r => r.name === 'Zebra').id).toBe(3);
    expect(db.prepare(
      'SELECT c.name AS child, p.name AS parent FROM parent e ' +
      'JOIN cat c ON c.id=e.child JOIN cat p ON p.id=e.parent ORDER BY c.name',
    ).all()).toEqual([
      { child: 'Apple', parent: 'Mango' },
      { child: 'Zebra', parent: 'Apple' },
    ]);
  });

  it('renumbers a large graph without losing, duplicating or inverting edges', () => {
    const db = openDb(':memory:');
    const count = 300;
    const insertCat = db.prepare('INSERT INTO cat(name) VALUES (?)');
    const insertParent = db.prepare('INSERT INTO parent(child,parent) VALUES (?,?)');
    const insertMember = db.prepare('INSERT INTO member(article,cat) VALUES (?,?)');
    const idOf = new Map();
    // Inserted in an order that has nothing to do with alphabetical order.
    for (let i = count - 1; i >= 0; i--) {
      const name = 'Cat ' + String(i).padStart(4, '0');
      insertCat.run(name);
      idOf.set(name, db.prepare('SELECT id FROM cat WHERE name=?').get(name).id);
    }
    const edges = [];
    for (let i = 0; i < count; i++) {
      const child = 'Cat ' + String(i).padStart(4, '0');
      if (i === 0) continue;
      const parent = 'Cat ' + String(i - 1).padStart(4, '0');
      insertParent.run(idOf.get(child), idOf.get(parent));
      edges.push([child, parent]);
      insertMember.run('article-' + String(i).padStart(4, '0'), idOf.get(child));
    }

    assignStableIds(db);

    const after = db.prepare(
      'SELECT c.name AS child, p.name AS parent FROM parent e ' +
      'JOIN cat c ON c.id=e.child JOIN cat p ON p.id=e.parent',
    ).all().map(r => [r.child, r.parent]);
    expect(after).toEqual(edges);
    expect(db.prepare('SELECT COUNT(*) AS n FROM parent').get().n).toBe(edges.length);
    expect(db.prepare(
      'SELECT m.article, c.name FROM member m JOIN cat c ON c.id=m.cat ORDER BY m.article',
    ).all()).toEqual(edges.map(([child]) => ({ article: 'article-' + child.slice(-4), name: child })));
    // No self loops: a cycle of length one would wreck tree building downstream.
    expect(db.prepare('SELECT COUNT(*) AS n FROM parent WHERE child=parent').get().n).toBe(0);
    // The remap is a bijection - every category keeps a distinct id.
    expect(db.prepare('SELECT COUNT(DISTINCT id) AS n FROM cat').get().n).toBe(count);
  });
});

describe('finalizeIndexes', () => {
  it('creates the four query indexes and is idempotent', () => {
    const db = openDb(':memory:');
    finalizeIndexes(db);
    finalizeIndexes(db);
    const names = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`,
    ).all().map(r => r.name);
    expect(names).toEqual([
      'idx_member_article', 'idx_member_cat', 'idx_parent_child', 'idx_parent_parent',
    ]);
  });
});