import { randomUUID } from 'crypto';
import { all, run } from './server/db/queries.js';

/**
 * Log an admin action to the audit trail
 * @param {string} action - Action type (e.g. 'content_create', 'user_update', 'submission_approve')
 * @param {string} details - Human-readable description
 * @param {object} req - Express request object (for session userId, IP, user-agent)
 */
export async function addLog(action, details, req) {
  try {
    const id = randomUUID();
    await run(
      'INSERT INTO system_logs (id, action, details, userId, ip, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        action,
        details,
        req?.session?.userId || null,
        req?.ip || req?.connection?.remoteAddress || null,
        req?.get('user-agent') || null,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.error('[audit] Failed to write log:', err.message);
  }
}

/**
 * Read logs with optional filtering
 */
export async function getLogs(filters = {}) {
  let sql = 'SELECT * FROM system_logs WHERE 1=1';
  const params = [];

  if (filters.action) {
    sql += ' AND action = ?';
    params.push(filters.action);
  }
  if (filters.userId) {
    sql += ' AND userId = ?';
    params.push(filters.userId);
  }
  if (filters.from) {
    sql += ' AND timestamp >= ?';
    params.push(new Date(filters.from).toISOString());
  }
  if (filters.to) {
    sql += ' AND timestamp <= ?';
    params.push(new Date(filters.to).toISOString());
  }

  sql += ' ORDER BY timestamp DESC LIMIT 500';
  const logs = await all(sql, params);
  return logs;
}

