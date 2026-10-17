// ============================================================
//  CPRI — publishing to the repository, and the dashboard's submission list
//
//  Offline: lib/repository-publishing.js and lib/submission-index.js take
//  their data layer as an argument, so a small in-memory store stands in for
//  MySQL. The database-backed half (real SQL, real routes) is
//  test-dashboard-publishing-db.mjs.
//
//  Proves:
//   1. Publishing creates one repository entry and one publication, and
//      publishing again refreshes them instead of adding copies.
//   2. Hiding (a later rejection) takes the entry off the public pages without
//      deleting it, and removes the auto-added publication.
//   3. The automatic sync only publishes what it is allowed to.
//   4. The dashboard list holds every submission from both stores once,
//      without drafts, and knows which ones are in the repository.
//
//  Run: npm run test:repository-publishing
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fromClassicSubmission,
  fromModuleSubmission,
  publishSubmission,
  hideSubmission,
  syncSubmissionVisibility
} from '../lib/repository-publishing.js';
import { listAllSubmissions } from '../lib/submission-index.js';

// Understands the query shapes these modules issue: one FROM table and
// optional `col = ?` conditions joined by AND.
function memoryStore(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map(r => ({ ...r }))]));
  const rows = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const select = (sql, params = []) => {
    const table = sql.match(/\bFROM\s+([A-Za-z_]+)/i)[1];
    const where = (sql.split(/\bWHERE\b/i)[1] || '').split(/\bORDER BY\b/i)[0];
    const cols = [...where.matchAll(/([A-Za-z_]+)\s*=\s*\?/g)].map(m => m[1]);
    return rows(table).filter(row => cols.every((col, i) => String(row[col]) === String(params[i])));
  };
  return {
    tables,
    rows,
    get: async (sql, params) => { const [r] = select(sql, params); return r ? { ...r } : null; },
    all: async (sql, params) => select(sql, params).map(r => ({ ...r })),
    insert: async (table, record) => { rows(table).push({ ...record }); },
    update: async (table, id, changes) => { Object.assign(rows(table).find(r => r.id === id) || {}, changes); },
    remove: async (table, id) => {
      const list = rows(table);
      const i = list.findIndex(r => r.id === id);
      if (i >= 0) list.splice(i, 1);
    }
  };
}

const moduleRow = (id, fields = {}) => ({
  id,
  owner_id: 'u-student',
  owner_name: 'Student Person',
  owner_role: 'student_researcher',
  stage: 'final',
  title: `Module paper ${id}`,
  authors: 'S. Person',
  program: 'BS Biology',
  category: 'Life Sciences',
  research_type: 'student_thesis',
  school_year: '2025-2026',
  abstract: 'An abstract.',
  keywords: 'water, climate',
  status: 'submitted',
  created_at: '2026-03-01 08:00:00',
  updated_at: '2026-03-01 08:00:00',
  ...fields
});

const classicRow = (id, fields = {}) => ({
  id,
  submitterId: 'u-classic',
  submitterName: 'Classic Person',
  title: `Classic paper ${id}`,
  authors: 'C. Person',
  program: 'BS IT',
  researchType: 'capstone',
  schoolYear: '2024-2025',
  abstract: 'Classic abstract.',
  keywords: 'robots',
  status: 'submitted',
  statusHistory: [],
  files: { manuscript: { storage_path: 'x/manuscript.pdf', original_name: 'm.pdf' } },
  createdAt: '2026-02-01 08:00:00',
  updatedAt: '2026-02-01 08:00:00',
  ...fields
});

// ===========================================================================
//  Publishing and hiding
// ===========================================================================
test('publishing creates one public repository entry and one publication', async () => {
  const db = memoryStore();
  const result = await publishSubmission(db, fromModuleSubmission(moduleRow('m1')), { status: 'approved' });

  const [entry] = db.rows('repository');
  assert.equal(db.rows('repository').length, 1);
  assert.equal(entry.id, result.repositoryId);
  assert.equal(entry.sourceSubmissionId, 'm1');
  assert.equal(entry.status, 'approved');
  assert.equal(entry.title, 'Module paper m1');
  assert.equal(entry.department, 'BS Biology');
  assert.equal(entry.category, 'student_thesis', 'the research type is the repository category');
  assert.equal(entry.keywords, 'water, climate');
  assert.equal(entry.yearCompleted, '2026');
  assert.equal(entry.fileAvailable, 0, 'module uploads are private, never a public download');
  assert.equal(JSON.parse(entry.citation).apa, 'S. Person (2026). Module paper m1. BS Biology.');

  const [pub] = db.rows('publications');
  assert.equal(db.rows('publications').length, 1);
  assert.equal(pub.id, result.publicationId);
  assert.equal(pub.sourceSubmissionId, 'm1');
  assert.equal(pub.status, 'published');
  assert.equal(pub.authorType, 'student', 'from the submitter, not from whoever approved it');
});

test('publishing again refreshes the same rows instead of adding copies', async () => {
  const db = memoryStore();
  const first = await publishSubmission(db, fromClassicSubmission(classicRow('c1')), { status: 'approved', at: '2026-04-01T00:00:00.000Z' });
  // An admin edits the entry's citation in between.
  await db.update('repository', first.repositoryId, { citation: { mla: 'edited', apa: 'edited' } });

  const again = await publishSubmission(
    db,
    fromClassicSubmission(classicRow('c1', { title: 'Renamed' })),
    { status: 'published', at: '2026-05-01T00:00:00.000Z' }
  );
  assert.equal(again.repositoryId, first.repositoryId);
  assert.equal(again.publicationId, first.publicationId);
  assert.equal(again.created, false);
  assert.equal(db.rows('repository').length, 1);
  assert.equal(db.rows('publications').length, 1);
  assert.equal(db.rows('repository')[0].title, 'Renamed');
  assert.equal(db.rows('repository')[0].status, 'published');
  assert.deepEqual(db.rows('repository')[0].citation, { mla: 'edited', apa: 'edited' }, 'an edited citation is kept');
  assert.equal(db.rows('repository')[0].fileAvailable, 1, 'a classic manuscript is downloadable');
  assert.equal(db.rows('publications')[0].publicationDate, '2026-04-01', 'first publication date is kept');
});

test('a non-public status is never written to a published entry', async () => {
  const db = memoryStore();
  await publishSubmission(db, fromModuleSubmission(moduleRow('m2')), { status: 'under_initial_checking' });
  assert.equal(db.rows('repository')[0].status, 'approved', 'a manual publish must be visible');
});

test('hiding keeps the repository entry but takes it off the public pages', async () => {
  const db = memoryStore();
  await publishSubmission(db, fromModuleSubmission(moduleRow('m3')), { status: 'approved' });

  assert.equal(await hideSubmission(db, 'm3', 'rejected'), true);
  assert.equal(db.rows('repository').length, 1, 'the entry is kept for the admin');
  assert.equal(db.rows('repository')[0].status, 'rejected');
  assert.equal(db.rows('publications').length, 0, 'the auto-added publication is removed');

  assert.equal(await hideSubmission(db, 'm3', 'rejected'), false, 'hiding twice changes nothing');
  assert.equal(await hideSubmission(db, 'never-published', 'rejected'), false);
});

test('a publication added by hand for another record is left alone', async () => {
  const db = memoryStore({ publications: [{ id: 'p-other', sourceSubmissionId: null, status: 'published' }] });
  await publishSubmission(db, fromModuleSubmission(moduleRow('m4')), { status: 'approved' });
  await hideSubmission(db, 'm4', 'rejected');
  assert.deepEqual(db.rows('publications').map(p => p.id), ['p-other']);
});

test('the automatic sync publishes on approval and hides on rejection', async () => {
  const db = memoryStore();
  const source = fromModuleSubmission(moduleRow('m5'));

  assert.equal(await syncSubmissionVisibility(db, source, 'for_revision'), 'unchanged');
  assert.equal(db.rows('repository').length, 0);

  assert.equal(await syncSubmissionVisibility(db, source, 'approved'), 'published');
  assert.equal(db.rows('repository')[0].status, 'approved');
  assert.equal(db.rows('publications').length, 1);

  assert.equal(await syncSubmissionVisibility(db, source, 'published'), 'published');
  assert.equal(db.rows('repository')[0].status, 'published');
  assert.equal(db.rows('publications').length, 1);

  assert.equal(await syncSubmissionVisibility(db, source, 'rejected'), 'hidden');
  assert.equal(db.rows('repository')[0].status, 'rejected');
  assert.equal(db.rows('publications').length, 0);
});

test('without autoPublish, approval only refreshes an entry an admin already published', async () => {
  const db = memoryStore();
  const source = fromModuleSubmission(moduleRow('m6', { stage: 'initial' }));

  assert.equal(await syncSubmissionVisibility(db, source, 'approved', { autoPublish: false }), 'unchanged');
  assert.equal(db.rows('repository').length, 0, 'an approved proposal is not published by itself');

  await publishSubmission(db, source, { status: 'approved' });
  assert.equal(await syncSubmissionVisibility(db, source, 'approved', { autoPublish: false }), 'published');
  assert.equal(await syncSubmissionVisibility(db, source, 'rejected', { autoPublish: false }), 'hidden',
    'rejection hides it whatever the stage');
});

// ===========================================================================
//  The dashboard's list of submissions
// ===========================================================================
test('the dashboard list holds both stores, once each, without drafts', async () => {
  const db = memoryStore({
    research_submissions: [
      moduleRow('m-new', { created_at: '2026-06-01 00:00:00' }),
      moduleRow('m-draft', { status: 'draft' }),
      // Migrated: the same id lives in both stores, the module copy is newer.
      moduleRow('shared', { status: 'approved', updated_at: '2026-07-01 00:00:00', created_at: '2026-01-15 00:00:00' })
    ],
    research_status_history: [
      { submission_id: 'shared', to_status: 'under_initial_checking', changed_at: '2026-01-20 00:00:00' },
      { submission_id: 'shared', to_status: 'approved', changed_at: '2026-02-02 00:00:00' }
    ],
    submissions: [
      classicRow('c-old', { createdAt: '2025-12-01 00:00:00', statusHistory: [{ status: 'published', at: '2025-12-09T00:00:00Z' }], status: 'published' }),
      classicRow('shared', { status: 'submitted', updatedAt: '2026-01-15 00:00:00', createdAt: '2026-01-15 00:00:00' })
    ],
    repository: [
      { id: 'r-1', sourceSubmissionId: 'c-old', status: 'published' },
      { id: 'r-2', sourceSubmissionId: 'shared', status: 'rejected' },
      { id: 'r-3', sourceSubmissionId: null, status: 'published' }
    ],
    users: []
  });

  const list = await listAllSubmissions({ all: db.all, log: () => {} });
  assert.deepEqual(list.map(r => r.id), ['m-new', 'shared', 'c-old'], 'newest first, drafts left out');

  const shared = list.find(r => r.id === 'shared');
  assert.equal(shared.status, 'approved', 'the copy updated last wins');
  assert.deepEqual(shared.sources.sort(), ['classic', 'module']);
  assert.equal(shared.approved_at, '2026-02-02 00:00:00', 'module approval time from its history');
  assert.equal(shared.inRepository, false, 'a hidden entry is not "in the repository"');
  assert.equal(shared.repositoryStatus, 'rejected');

  const old = list.find(r => r.id === 'c-old');
  assert.equal(old.inRepository, true);
  assert.equal(old.repositoryId, 'r-1');
  assert.equal(old.approved_at, '2025-12-09T00:00:00Z', 'classic approval time from its JSON history');
  assert.equal(old.source, 'classic');

  const fresh = list.find(r => r.id === 'm-new');
  assert.equal(fresh.inRepository, false);
  assert.equal(fresh.repositoryId, null);
  assert.equal(fresh.detailUrl, '/research-submission-detail.html?id=m-new');

  const withDrafts = await listAllSubmissions({ all: db.all, includeDrafts: true, log: () => {} });
  assert.ok(withDrafts.some(r => r.id === 'm-draft'));
});

test('a store that cannot be read leaves the other one on the dashboard', async () => {
  const db = memoryStore({ submissions: [classicRow('c-only')], users: [] });
  const all = async (sql, params) => {
    if (/research_/.test(sql)) throw new Error("Table 'research_submissions' doesn't exist");
    return db.all(sql, params);
  };
  const list = await listAllSubmissions({ all, log: () => {} });
  assert.deepEqual(list.map(r => r.id), ['c-only']);
});

test('a published entry carries the facilitator and the researcher\'s own category', async () => {
  const db = memoryStore();
  await publishSubmission(db, fromModuleSubmission(moduleRow('m-fac', { facilitator_id: 'Ms. Facilitator' })), { status: 'approved' });
  const [moduleEntry] = db.rows('repository');
  assert.equal(moduleEntry.facilitator, 'Ms. Facilitator');
  assert.equal(moduleEntry.researchCategory, 'Life Sciences', 'the free-text category, kept apart from the research type');
  assert.equal(moduleEntry.category, 'student_thesis');

  await publishSubmission(db, fromClassicSubmission(classicRow('c-fac', { category: 'Robotics' })), { status: 'approved' });
  const classicEntry = db.rows('repository').find(r => r.sourceSubmissionId === 'c-fac');
  assert.equal(classicEntry.researchCategory, 'Robotics');
  assert.equal(classicEntry.facilitator, null, 'the classic form never asked for one');
});
