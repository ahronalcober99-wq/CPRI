import '../load-env.js';
import { all } from '../server/db/queries.js';
const rows = await all('SELECT username, role, status FROM users ORDER BY createdAt DESC LIMIT 40');
console.log('total(limit40):', rows.length);
for (const r of rows) console.log(`${r.username} | ${r.role} | ${r.status}`);
const counts = await all('SELECT role, COUNT(*) AS n FROM users GROUP BY role');
console.log('--- by role ---');
for (const c of counts) console.log(`${c.role}: ${c.n}`);
process.exit(0);
