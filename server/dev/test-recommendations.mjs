// ============================================================
//  CPRI — "Recommended Research" ranking (lib/recommendations.js)
//
//  Pure: no database, no server. Proves the ranking order the brief asks for
//  (shared keywords, then category, then department), that every
//  recommendation explains itself, and that only public entries other than
//  the record itself are ever recommended.
//
//  Run: npm run test:recommendations
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKeywords,
  profileOf,
  recommend,
  recommendationsFor,
  humanizeCategory
} from '../lib/recommendations.js';

const entry = (id, fields = {}) => ({
  id,
  title: `Paper ${id}`,
  authors: 'A. Author',
  keywords: '',
  category: '',
  department: '',
  yearCompleted: '2025',
  status: 'published',
  ...fields
});

test('keywords are split on commas, semicolons and new lines, case-insensitively, once each', () => {
  assert.deepEqual(
    parseKeywords('Climate Change; water,  #Flooding\nclimate change,,').map(k => k.key),
    ['climate change', 'water', 'flooding']
  );
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords(null), []);
});

test('ranked by shared keywords first, then category, then department', () => {
  const target = profileOf({
    keywords: 'climate, water, flooding',
    categories: ['student_thesis'],
    department: 'BS Biology'
  });
  const candidates = [
    entry('dept-only', { department: 'bs biology' }),
    entry('cat-only', { category: 'student_thesis' }),
    entry('cat+dept', { category: 'student_thesis', department: 'BS Biology' }),
    entry('one-kw', { keywords: 'Water' }),
    entry('two-kw', { keywords: 'flooding; climate' }),
    entry('one-kw+cat', { keywords: 'climate', category: 'student_thesis' }),
    entry('unrelated', { keywords: 'robots', category: 'capstone', department: 'BS IT' })
  ];

  const ranked = recommend(target, candidates, { limit: 10 });
  assert.deepEqual(ranked.map(r => r.id), [
    'two-kw',       // 2 shared keywords beat everything with fewer
    'one-kw+cat',   // 1 keyword, and the category breaks the tie
    'one-kw',
    'cat+dept',     // no keywords: category first, department breaks the tie
    'cat-only',
    'dept-only'
  ]);
  assert.ok(!ranked.some(r => r.id === 'unrelated'), 'nothing in common means not recommended');
});

test('every recommendation says why it matches', () => {
  const target = profileOf({ keywords: 'climate, water', categories: ['student_thesis'], department: 'BS Biology' });
  const [rec] = recommend(target, [
    entry('x', { keywords: 'Water, Climate', category: 'student_thesis', department: 'BS Biology' })
  ], { categoryLabel: c => ({ student_thesis: 'Student Thesis' })[c] });

  assert.deepEqual(rec.sharedKeywords, ['Water', 'Climate']);
  assert.deepEqual(rec.reasons, [
    'Shares 2 keywords: Water, Climate',
    'Same category: Student Thesis',
    'Same department: BS Biology'
  ]);
  assert.equal(rec.reason, rec.reasons.join(' · '));
  assert.equal(rec.url, '/repository-detail.html?id=x');

  const [single] = recommend(profileOf({ keywords: 'water' }), [entry('y', { keywords: 'water' })]);
  assert.deepEqual(single.reasons, ['Shares the keyword "water"']);
});

test('a category without a label is still readable', () => {
  assert.equal(humanizeCategory('faculty_research'), 'Faculty research');
  const [rec] = recommend(profileOf({ categories: ['faculty_research'] }), [entry('z', { category: 'faculty_research' })]);
  assert.deepEqual(rec.reasons, ['Same category: Faculty research']);
});

test('ties fall back to the newer entry, then the title', () => {
  const target = profileOf({ department: 'CAS' });
  const ranked = recommend(target, [
    entry('old', { department: 'CAS', yearCompleted: '2019', title: 'A' }),
    entry('new-b', { department: 'CAS', yearCompleted: '2024-2025', title: 'B' }),
    entry('new-a', { department: 'CAS', yearCompleted: '2025', title: 'A' })
  ]);
  assert.deepEqual(ranked.map(r => r.id), ['new-a', 'new-b', 'old']);
});

test('the limit applies, and a target with nothing to compare gets nothing', () => {
  const target = profileOf({ department: 'CAS' });
  const many = Array.from({ length: 9 }, (_, i) => entry(`e${i}`, { department: 'CAS' }));
  assert.equal(recommend(target, many).length, 5, 'five by default');
  assert.equal(recommend(target, many, { limit: 2 }).length, 2);
  assert.deepEqual(recommend(profileOf({}), many), []);
});

test('only public entries are candidates, and never the record itself', async () => {
  const rows = [
    entry('self', { department: 'CAS', sourceSubmissionId: 'sub-1' }),
    entry('mirror-of-target', { department: 'CAS', sourceSubmissionId: 'sub-target' }),
    entry('hidden', { department: 'CAS', status: 'rejected' }),
    entry('pending', { department: 'CAS', status: 'submitted' }),
    entry('approved', { department: 'CAS', status: 'Approved' }),
    entry('published', { department: 'CAS', status: 'published' })
  ];
  // The fake ignores the SQL on purpose: the function must filter by status
  // itself as well, so a data layer that returned everything still leaks nothing.
  const all = async () => rows.map(r => ({ ...r }));
  const recs = await recommendationsFor({
    all,
    profile: profileOf({ department: 'CAS' }),
    repositoryId: 'self',
    sourceId: 'sub-target'
  });
  assert.deepEqual(recs.map(r => r.id).sort(), ['approved', 'published']);
});
