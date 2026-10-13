// ============================================================
//  CPRI — Research Submission Module (back end)
//  Thin shim over the real server's data + session layer.
//
//  The module lives in its own folder (cpri-research-submission/) but is
//  mounted into the existing CPRI site (see server/server.js), so it must
//  use the SAME database pool and the SAME session guard as the rest of the
//  app. Nothing here opens a second connection or invents an identity.
//
//  Paths are relative to this file:
//    ../../server/server/db/queries.js  -> the real get/all/insert/update/remove
//    ../../server/auth.js               -> the real requireAuth / readUsers
// ============================================================
'use strict';

import { get, all, insert, update, remove } from '../../server/server/db/queries.js';
import { requireAuth, readUsers } from '../../server/auth.js';

export { get, all, insert, update, remove, requireAuth, readUsers };

// The caller's own user row, resolved from the session only. The router never
// trusts a role / owner_id sent by the client, so this is the single place
// where "who is this?" is decided.
export async function callerUser(req) {
  const id = req?.session?.userId;
  if (!id) return null;
  const user = await get(
    'SELECT id, username, email, fullName, role, status FROM users WHERE id = ?',
    [id]
  );
  if (!user || user.status === 'disabled') return null;
  return user;
}
