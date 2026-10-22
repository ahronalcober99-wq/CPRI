// ============================================================
//  CPRI — School Years admin API (server/school-years.js)
//
//  Runs offline: the database, the admin guard and the audit log are mocked, so
//  nothing touches MySQL/TiDB. Needs Node's module mocking:
//    npm run test:school-years
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const url = (p) => new URL('../' + p, import.meta.url).href;

const tables = { school_years: [], app_settings: [] };
const logs = [];
let isAdmin = true;

function parseTable(sql) { return (sql.match(/\b(?:FROM|INTO|UPDATE)\s+(\w+)/i) || [])[1]; }
const queries = {
  all: async (sql) => (tables[parseTable(sql)] || []).map(r => ({ ...r })),
  get: async (sql, p = []) => {
    const t = parseTable(sql);
    if (t === 'users') return { role: 'admin', status: 'active', username: 'admin1' };
    return (tables[t] || []).find(r => r.label === p[0] || r.setting_key === p[0]) || null;
  },
  run: async (sql, p = []) => {
    const t = parseTable(sql);
    if (/^INSERT/i.test(sql)) {
      if (t === 'school_years') tables.school_years.push({ label: p[0], is_active: p.length > 1 ? p[1] : 1 });
      else tables.app_settings.push({ setting_key: p[0], setting_value: p[1] });
    } else if (t === 'school_years') {
      const row = tables.school_years.find(r => r.label === p[p.length - 1]);
      if (/SET label/i.test(sql)) row.label = p[0];
      else row.is_active = /SET is_active = 1,/i.test(sql) ? 1 : p[0];
    } else {
      tables.app_settings.find(r => r.setting_key === p[2]).setting_value = p[0];
    }
    return {};
  },
  insert: async () => {}, update: async () => {}, remove: async () => {}
};

test('admin school years API', async (t) => {
  t.mock.module(url('server/db/queries.js'), { exports: queries });
  t.mock.module(url('auth.js'), { exports: {
    requireAdmin: (req, res, next) => isAdmin ? next() : res.status(403).json({ error: 'Admin access required.' })
  } });
  t.mock.module(url('audit.js'), { exports: { addLog: async (a, d) => { logs.push([a, d]); } } });
  const { schoolYearsRouter } = await import(url('school-years.js'));
  const { loadSchoolYears } = await import(url('lib/school-years.js'));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 'a1' }; next(); });
  app.use('/api/school-years', schoolYearsRouter);
  const server = await new Promise(r => { const l = app.listen(0, '127.0.0.1', () => r(l)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/school-years`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const D = '\u2013';

  // Public list: current + 4, current flagged.
  const pub = await call('GET', '');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.schoolYears.length, 5);
  assert.equal(pub.body.schoolYears.filter(y => y.isCurrent).length, 1);
  assert.equal(pub.body.current, pub.body.schoolYears[0].label);
  const current = pub.body.current;

  // Admin view includes settings.
  const adminList = await call('GET', '?all=1');
  assert.equal(adminList.body.startMonth, 6);
  assert.equal(adminList.body.defaultStartMonth, 6);

  // Add: valid, duplicate, malformed.
  assert.equal((await call('POST', '', { label: '2031-2032' })).status, 201);
  assert.ok((await call('GET', '')).body.schoolYears.some(y => y.label === `2031${D}2032`));
  assert.equal((await call('POST', '', { label: '2031-2032' })).status, 409);
  assert.equal((await call('POST', '', { label: '2031-2033' })).status, 400);
  assert.equal((await call('POST', '', { label: 'next year' })).status, 400);
  assert.equal((await call('POST', '', { label: current })).status, 409, 'generated year is already on the list');

  // Edit (rename) an added year; a generated year cannot be renamed.
  assert.equal((await call('PATCH', '', { label: `2031${D}2032`, newLabel: '2032-2033' })).status, 200);
  const names = (await call('GET', '')).body.schoolYears.map(y => y.label);
  assert.ok(names.includes(`2032${D}2033`) && !names.includes(`2031${D}2032`));
  assert.equal((await call('PATCH', '', { label: current, newLabel: '2040-2041' })).status, 400);
  assert.equal((await call('PATCH', '', { label: `2032${D}2033`, newLabel: current })).status, 409);

  // Hide / show a generated year; the current year cannot be hidden.
  const old = pub.body.schoolYears[2].label;
  assert.equal((await call('PATCH', '', { label: old, isActive: false })).status, 200);
  assert.ok(!(await call('GET', '')).body.schoolYears.some(y => y.label === old), 'hidden year not offered');
  assert.ok((await call('GET', '?all=1')).body.years.some(y => y.label === old && !y.isActive), 'but visible to the admin');
  assert.equal((await call('PATCH', '', { label: old, isActive: true })).status, 200);
  assert.ok((await call('GET', '')).body.schoolYears.some(y => y.label === old));
  assert.equal((await call('PATCH', '', { label: current, isActive: false })).status, 400);
  assert.equal((await call('PATCH', '', { label: `1900${D}1901`, isActive: false })).status, 404);

  // Start month setting.
  assert.equal((await call('PUT', '/settings', { startMonth: 13 })).status, 400);
  const set = await call('PUT', '/settings', { startMonth: 8 });
  assert.equal(set.status, 200);
  assert.equal((await call('GET', '?all=1')).body.startMonth, 8);
  assert.equal((await call('PUT', '/settings', { startMonth: 6 })).status, 200);
  assert.equal(tables.app_settings.length, 1, 'one row, updated in place');

  // Writes need an admin; the public list does not.
  isAdmin = false;
  assert.equal((await call('POST', '', { label: '2040-2041' })).status, 403);
  assert.equal((await call('PUT', '/settings', { startMonth: 1 })).status, 403);
  assert.equal((await call('GET', '')).status, 200);
  assert.equal((await call('GET', '?all=1')).status, 200, 'mock session user is an admin row, so the admin list is allowed here');

  assert.ok(logs.some(([a]) => a === 'school_year_create'));
  assert.ok(logs.some(([a]) => a === 'school_year_update'));
  assert.ok(logs.some(([a]) => a === 'school_year_settings'));
  // The validator reads the same state.
  const cfg = await loadSchoolYears({ all: queries.all });
  assert.ok(cfg.years.some(y => y.label === `2032${D}2033`));
});
