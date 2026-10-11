import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

// Static import on purpose. This module used to do `await import('dotenv')`,
// and that top-level await suspended it: Node kept evaluating the rest of the
// graph (server/db.js reads process.env at evaluation time) before dotenv had
// applied a single value, so a local `npm start` always ran against the
// localhost:3306 fallbacks ("file-only mode") even though `.env` was present
// and correct. A static import has no top-level await, so the values land
// before any sibling module evaluates.
//
// Production is untouched: Render injects real environment variables and
// NODE_ENV=production skips this block entirely.
if (process.env.NODE_ENV !== 'production') {
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
}
