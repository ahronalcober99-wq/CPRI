// ============================================================
//  Documentation check — ROUTES.md vs the router
//
//  Every route registered in server/research-submissions.js must have a
//  heading in ROUTES.md, and every heading in ROUTES.md must be a real
//  route. Exits non-zero when they diverge, so it can gate a change.
//
//  Run: node cpri-research-submission/check-doc.js
// ============================================================
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

const source = readFileSync(join(here, 'server', 'research-submissions.js'), 'utf8');
const doc = readFileSync(join(here, 'ROUTES.md'), 'utf8');

// `router.get('/me', ...)` — and the multi-line form
// `router.post(\n  '/:id/ethics',` — hence the newline-tolerant \s*.
const ROUTE_RE = /router\.(get|post|put|patch)\(\s*["']([^"']+)["']/g;

const sourceRoutes = [];
for (const match of source.matchAll(ROUTE_RE)) {
  sourceRoutes.push(`${match[1].toUpperCase()} /api/research-submissions${match[2]}`);
}

// Headings look like: ### GET /me   (the module prefix is stated once at the top)
const docRoutes = [...doc.matchAll(/^###\s+(GET|POST|PUT|PATCH)\s+(\S+)\s*$/gm)]
  // A query string is part of the doc's explanation, not of the route path.
  .map(m => `${m[1]} /api/research-submissions${m[2].split('?')[0]}`);

const unique = (list) => [...new Set(list)].sort();
const srcSet = unique(sourceRoutes);
const docSet = unique(docRoutes);

const onlyInSource = srcSet.filter(r => !docSet.includes(r));
const onlyInDoc = docSet.filter(r => !srcSet.includes(r));

console.log(`SOURCE routes (${srcSet.length}):`);
for (const route of srcSet) console.log(`  ${route}`);
console.log('');
console.log(`DOC headings (${docSet.length}):`);
for (const route of docSet) console.log(`  ${route}`);
console.log('');
console.log(`ONLY IN SOURCE (undocumented): ${onlyInSource.length ? onlyInSource.join(', ') : 'none'}`);
console.log(`ONLY IN DOC (no such route):   ${onlyInDoc.length ? onlyInDoc.join(', ') : 'none'}`);

const ok = onlyInSource.length === 0 && onlyInDoc.length === 0;
console.log('');
console.log(ok
  ? 'MUTUAL RECIPROCAL: YES — every route is documented and every documented route exists.'
  : 'MUTUAL RECIPROCAL: NO — fix the mismatch above.');

process.exit(ok ? 0 : 1);
