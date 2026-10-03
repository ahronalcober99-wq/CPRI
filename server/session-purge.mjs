#!/usr/bin/env node
// Session purge — deletes expired file-backed sessions from server/data/sessions/.
// Run manually:  node server/session-purge.mjs
// Or via npm:    npm run purge:sessions
//
// The main server session TTL is 8 hours. This script deletes any session file
// whose embedded cookie.expires is in the past, or whose file has not been
// modified in the last SESSION_MAX_AGE_MS milliseconds (fallback).

import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SESSIONS_DIR = join(__dirname, 'data', 'sessions');

// Match the maxAge in server.js (8 hours)
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8;

async function purge() {
  let files;
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    console.log('[purge] No sessions directory found at', SESSIONS_DIR);
    return;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  console.log(`[purge] Found ${jsonFiles.length} session file(s) in ${SESSIONS_DIR}`);

  let removed = 0;
  let kept = 0;
  const now = Date.now();

  for (const file of jsonFiles) {
    const filePath = join(SESSIONS_DIR, file);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      let expired = false;

      try {
        const data = JSON.parse(raw);
        if (data.cookie && data.cookie.expires) {
          expired = new Date(data.cookie.expires).getTime() < now;
        }
      } catch {
        // Malformed JSON — treat as expired
        expired = true;
      }

      if (!expired) {
        // Fallback: check file modification time
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > SESSION_MAX_AGE_MS) {
          expired = true;
        }
      }

      if (expired) {
        await fs.unlink(filePath);
        removed++;
      } else {
        kept++;
      }
    } catch (err) {
      console.warn(`[purge] Could not process ${file}:`, err.message);
    }
  }

  console.log(`[purge] Done — removed ${removed}, kept ${kept}`);
}

purge().catch(err => {
  console.error('[purge] Fatal error:', err);
  process.exit(1);
});
