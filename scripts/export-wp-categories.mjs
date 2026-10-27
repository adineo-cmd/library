/**
 * Export the Wikipedia category pool from the local atlas.db — the full
 * 2.6M-category graph is already ingested from the wiki dumps, so "gather
 * everything from the internet" needs zero network: one local read.
 *
 * Output: atlas-work/wp-categories.json — [{ name, articles }] for every
 * subject category with at least MIN_ARTICLES articles, maintenance
 * scaffolding filtered out. The build classifies these into the spine by
 * keyword; unmatched categories are dropped, which keeps the quality bar.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMaintenanceCategory, normalizeCategoryName } from './lib/categories.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_ARTICLES = 4;

const db = new Database(resolve(ROOT, 'atlas-work/atlas.db'), { readonly: true });

// article counts per category id, straight off the member table
const counts = new Map();
for (const { cat, c } of db.prepare('SELECT cat, COUNT(*) AS c FROM member GROUP BY cat').iterate()) {
  counts.set(cat, c);
}

const cats = db.prepare('SELECT id, name FROM cat').iterate();
const out = [];
let seen = 0, maintained = 0, small = 0;
for (const { id, name } of cats) {
  seen++;
  const clean = normalizeCategoryName(name);
  if (isMaintenanceCategory(clean)) { maintained++; continue; }
  const articles = counts.get(id) ?? 0;
  if (articles < MIN_ARTICLES) { small++; continue; }
  out.push({ name: clean, articles });
}
out.sort((a, b) => b.articles - a.articles);

writeFileSync(resolve(ROOT, 'atlas-work/wp-categories.json'), JSON.stringify(out));
console.log(`seen=${seen} maintenance=${maintained} small=${small} written=${out.length}`);
console.log('top 20:', out.slice(0, 20).map(c => `${c.name} (${c.articles})`).join(' | '));
