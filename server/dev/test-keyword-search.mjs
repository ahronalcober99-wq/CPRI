// Tests for the quick keyword search helper (server/lib/keyword-search.js)
// used by GET /api/publications and GET /api/repository.
//
// Run: npm run test:keyword-search
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendKeywordSearch, MAX_TERMS, MAX_TERM_LENGTH } from '../lib/keyword-search.js';

const BASE = 'SELECT * FROM t WHERE 1=1';

test('empty or missing input leaves SQL and params unchanged', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const params = ['x'];
    assert.equal(appendKeywordSearch(BASE, params, raw, ['a', 'b']), BASE);
    assert.deepEqual(params, ['x']);
  }
});

test('each term becomes an OR group, groups are ANDed', () => {
  const params = [];
  const sql = appendKeywordSearch(BASE, params, '  smith   nursing ', ['title', 'authors']);
  assert.equal(sql, BASE + ' AND (title LIKE ? OR authors LIKE ?) AND (title LIKE ? OR authors LIKE ?)');
  assert.deepEqual(params, ['%smith%', '%smith%', '%nursing%', '%nursing%']);
});

test('term count and term length are capped', () => {
  const params = [];
  const raw = Array.from({ length: MAX_TERMS + 4 }, (_, i) => 'w' + i).join(' ') + ' ' + 'x'.repeat(500);
  const sql = appendKeywordSearch(BASE, params, raw, ['title']);
  assert.equal(params.length, MAX_TERMS);
  assert.equal((sql.match(/LIKE \?/g) || []).length, MAX_TERMS);

  const longParams = [];
  appendKeywordSearch(BASE, longParams, 'x'.repeat(500), ['title']);
  assert.equal(longParams[0].length, MAX_TERM_LENGTH + 2);
});

test('user text never reaches the SQL string', () => {
  const params = [];
  const raw = "50%_off ') OR 1=1 --";
  const sql = appendKeywordSearch(BASE, params, raw, ['title']);
  assert.ok(!sql.includes('50%_off'));
  assert.ok(!sql.includes('1=1 --'));
  assert.ok(!sql.includes("')"));
  assert.ok(params.includes('%50%_off%'));
});
