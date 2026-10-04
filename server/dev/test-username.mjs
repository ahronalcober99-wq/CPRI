import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { normalizeUsername, validateUsername, buildUsernameCandidates } from '../utils/username.js';
import { createUsernameRouter } from '../username.js';

async function startTestApi(dependencies) {
  const app = express();
  app.use('/api/username', createUsernameRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/api/username`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

test('normalizes by trimming and lowercasing', () => {
  assert.equal(normalizeUsername('  Ahron_2  '), 'ahron_2');
});

test('enforces every username rule with ordered, specific messages', () => {
  assert.deepEqual(validateUsername('abc'), {
    valid: false,
    username: 'abc',
    reason: 'too_short',
    message: 'Username must be at least 4 characters.'
  });
  assert.deepEqual(validateUsername('abcd'), { valid: true, username: 'abcd' });
  assert.deepEqual(validateUsername('a'.repeat(20)), { valid: true, username: 'a'.repeat(20) });
  assert.deepEqual(validateUsername('a'.repeat(21)), {
    valid: false,
    username: 'a'.repeat(21),
    reason: 'too_long',
    message: 'Username must be no more than 20 characters.'
  });
  assert.deepEqual(validateUsername('2abc'), {
    valid: false,
    username: '2abc',
    reason: 'start',
    message: 'Username must start with a letter.'
  });
  assert.deepEqual(validateUsername('abc-1'), {
    valid: false,
    username: 'abc-1',
    reason: 'characters',
    message: 'Use only letters, numbers, dot and underscore.'
  });
  assert.deepEqual(validateUsername('ab..cd'), {
    valid: false,
    username: 'ab..cd',
    reason: 'repeated_dot',
    message: 'Username cannot contain consecutive dots.'
  });
  assert.deepEqual(validateUsername('ab__cd'), {
    valid: false,
    username: 'ab__cd',
    reason: 'repeated_underscore',
    message: 'Username cannot contain consecutive underscores.'
  });
  assert.deepEqual(validateUsername('Ahron_2.test'), { valid: true, username: 'ahron_2.test' });
});

test('builds candidates in order using the last full-name token', () => {
  assert.deepEqual(
    buildUsernameCandidates('Ahron', 'Ahron Alcober', 2026, ['z9q2']),
    ['ahron_alcober', 'ahron.cpri', 'ahron_cpri26', 'ahron.z9q2']
  );
});

test('filters invalid candidates, removes duplicates, and returns only valid names', () => {
  const candidates = buildUsernameCandidates('ahron', 'Ahron '.concat('9'.repeat(20)), 2026, ['cpri', 'z9q2', 'z9q2']);

  assert.deepEqual(candidates, ['ahron.cpri', 'ahron_cpri26', 'ahron.z9q2']);
  assert.equal(new Set(candidates).size, candidates.length);
  assert.ok(candidates.every(candidate => validateUsername(candidate).valid));
});

test('checks availability, returns only free suggestions, and binds normalized candidates', async () => {
  const recordedCalls = [];
  const takenNames = new Set(['TAKEN_ALCOBER', 'TAKEN.CPRI']);
  const api = await startTestApi({
    getQuery: async (sql, params) => {
      recordedCalls.push({ sql, params });
      return params[0] === 'taken' ? { id: 'existing-user' } : null;
    },
    allQuery: async (sql, params) => {
      recordedCalls.push({ sql, params });
      return params.filter(candidate => takenNames.has(candidate.toUpperCase()))
        .map(username => ({ username }));
    },
    randomSuffix: () => 'ab12'
  });

  try {
    assert.deepEqual(await getJson(`${api.url}/check?username=%20BAD-USER%20`), {
      status: 200,
      body: { available: false, reason: 'invalid', message: 'Use only letters, numbers, dot and underscore.' }
    });
    assert.deepEqual(await getJson(`${api.url}/check?username=Free_Name`), {
      status: 200,
      body: { available: true }
    });
    assert.deepEqual(recordedCalls, [{
      sql: 'SELECT id FROM users WHERE LOWER(username) = ?',
      params: ['free_name']
    }]);

    recordedCalls.length = 0;
    const taken = await getJson(`${api.url}/check?username=taken&fullName=Ahron%20Alcober`);
    assert.equal(taken.status, 200);
    assert.deepEqual(taken.body, {
      available: false,
      reason: 'taken',
      suggestions: ['taken_cpri26', 'taken.ab12']
    });
    assert.equal(recordedCalls[0].params[0], 'taken');
    const candidateCalls = recordedCalls.filter(call => call.sql.includes('LOWER(username) IN'));
    assert.equal(candidateCalls.length, 1);
    assert.deepEqual(candidateCalls[0].params, ['taken_alcober', 'taken.cpri', 'taken_cpri26', 'taken.ab12']);
    assert.ok(candidateCalls[0].sql.includes('IN (?, ?, ?, ?)'));
  } finally {
    await api.close();
  }
});

test('checks candidate batches at most five times and returns no more than four suggestions', async () => {
  let candidateBatches = 0;
  let suffixIndex = 0;
  const api = await startTestApi({
    getQuery: async () => ({ id: 'existing-user' }),
    allQuery: async (sql, params) => {
      if (sql.includes('LOWER(username) IN')) candidateBatches += 1;
      return params.map(username => ({ username }));
    },
    randomSuffix: () => `a${String(suffixIndex++).padStart(3, '0')}`
  });

  try {
    const response = await getJson(`${api.url}/check?username=taken`);
    assert.deepEqual(response.body, { available: false, reason: 'taken', suggestions: [] });
    assert.equal(candidateBatches, 5);
  } finally {
    await api.close();
  }
});

test('limits username checks to 30 requests per minute per IP', async () => {
  const api = await startTestApi({
    getQuery: async () => null,
    allQuery: async () => [],
    randomSuffix: () => 'ab12'
  });

  try {
    const responses = [];
    for (let index = 0; index < 31; index += 1) {
      responses.push(await getJson(`${api.url}/check?username=free_name`));
    }
    assert.ok(responses.slice(0, 30).every(response => response.status === 200));
    assert.equal(responses[30].status, 429);
  } finally {
    await api.close();
  }
});
