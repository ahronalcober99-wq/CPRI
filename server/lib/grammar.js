// ============================================================
//  CPRI — grammar suggestions (LanguageTool)
//
//  Advisory only: a presenter or student can ask for suggestions on an
//  abstract; nothing here ever blocks a save or a submission. Every failure
//  (timeout, rate limit, service down) resolves to { available: false } so a
//  caller never has to handle an exception.
//
//  LANGUAGETOOL_URL defaults to the public API. That API is free but limited
//  (about 20 KB of text and 20 requests a minute) and it is a third party: the
//  text is sent to it. Point LANGUAGETOOL_URL at a self-hosted LanguageTool
//  (the erikvl87/languagetool Docker image) to keep the text on your own server.
// ============================================================
'use strict';

export const GRAMMAR_MAX_CHARS = 20000; // the public API's limit is 20 KB
const TIMEOUT_MS = 8000;
const MAX_SUGGESTIONS = 3;

export function languageToolUrl(env = process.env) {
  return String(env.LANGUAGETOOL_URL || 'https://api.languagetool.org').replace(/\/+$/, '');
}

// The public API wants a language code; "auto" detects it.
function shape(match) {
  return {
    offset: match.offset,
    length: match.length,
    message: String(match.message || ''),
    ruleId: String(match.rule?.id || ''),
    category: String(match.rule?.category?.name || ''),
    replacements: (match.replacements || []).slice(0, MAX_SUGGESTIONS).map(r => String(r.value))
  };
}

/**
 * @param {string} text
 * @param {{fetchImpl?: typeof fetch, url?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{available: boolean, issues: Array, reason?: string}>}
 */
export async function checkGrammar(text, { fetchImpl = fetch, url = languageToolUrl(), timeoutMs = TIMEOUT_MS } = {}) {
  const input = String(text ?? '');
  if (!input.trim()) return { available: true, issues: [] };
  if (input.length > GRAMMAR_MAX_CHARS) {
    return { available: false, issues: [], reason: 'too_long' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/v2/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ text: input, language: 'auto', preferredVariants: 'en-US' }).toString(),
      signal: controller.signal
    });
    if (!res.ok) return { available: false, issues: [], reason: res.status === 429 ? 'rate_limited' : 'service_error' };
    const data = await res.json();
    const issues = (Array.isArray(data.matches) ? data.matches : [])
      .filter(m => Number.isInteger(m.offset) && Number.isInteger(m.length) && m.length > 0)
      .map(shape);
    return { available: true, issues };
  } catch (err) {
    return { available: false, issues: [], reason: err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
