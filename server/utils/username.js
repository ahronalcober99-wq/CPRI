export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  const invalid = (reason, message) => ({ valid: false, username, reason, message });

  if (username.length < 4) return invalid('too_short', 'Username must be at least 4 characters.');
  if (username.length > 20) return invalid('too_long', 'Username must be no more than 20 characters.');
  if (!/^[a-z]/.test(username)) return invalid('start', 'Username must start with a letter.');
  if (!/^[a-z0-9._]+$/.test(username)) return invalid('characters', 'Use only letters, numbers, dot and underscore.');
  if (/\.\./.test(username)) return invalid('repeated_dot', 'Username cannot contain consecutive dots.');
  if (/__/.test(username)) return invalid('repeated_underscore', 'Username cannot contain consecutive underscores.');

  return { valid: true, username };
}

export function buildUsernameCandidates(username, fullName, year, randomSuffixes) {
  const normalizedUsername = normalizeUsername(username);
  const nameTokens = String(fullName ?? '').trim().split(/\s+/);
  const lastNameToken = (nameTokens.at(-1) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const candidates = [];

  if (lastNameToken) candidates.push(`${normalizedUsername}_${lastNameToken}`);
  candidates.push(`${normalizedUsername}.cpri`);
  candidates.push(`${normalizedUsername}_cpri${String(year).slice(-2)}`);

  for (const suffix of randomSuffixes ?? []) {
    candidates.push(`${normalizedUsername}.${normalizeUsername(suffix)}`);
  }

  const seen = new Set();
  return candidates.filter(candidate => {
    const normalized = normalizeUsername(candidate);
    if (seen.has(normalized) || !validateUsername(normalized).valid) return false;
    seen.add(normalized);
    return true;
  });
}
