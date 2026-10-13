// One-off: aligns an already-created gala_submissions table (from an earlier
// boot, when the columns were declared longtext) with the convention in
// server/init-db.sql, where JSON payloads use the JSON type so the driver hands
// them back parsed. Safe to run more than once.
//
//   node server/dev/fix-gala-json-columns.mjs
import '../load-env.js';
import { all, run } from '../server/db/queries.js';

const types = async () => {
  const cols = await all(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'gala_submissions'"
  );
  return cols.filter(c => /statushistory|files/i.test(c.column_name)).map(c => `${c.column_name}:${c.data_type}`);
};

console.log('before:', (await types()).join(', ') || '(table not found)');
await run('ALTER TABLE gala_submissions MODIFY statusHistory JSON DEFAULT NULL, MODIFY files JSON DEFAULT NULL');
console.log('after: ', (await types()).join(', '));
process.exit(0);
