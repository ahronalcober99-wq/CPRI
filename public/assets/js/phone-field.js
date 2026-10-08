// ============================================================
//  Contact-number (SMS) verification UI — profile.html
//
//  The pure rules (normalizing a PH mobile number, masking it,
//  splitting a pasted code, formatting countdowns) are exported
//  so they can be unit-tested in plain Node, and initPhoneField()
//  does the DOM wiring.
//
//  profile.html loads this as an ES module once the profile has
//  been fetched, and passes CPRI.toast in for notifications.
// ============================================================

const CODE_LENGTH = 6;

/** Mirror of server/lib/phone.js — 09171234567 / 9171234567 / +639171234567 → +639171234567 */
export function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().replace(/[\s().\-]/g, '');
  if (!raw) return null;
  if (/^\+639\d{9}$/.test(raw)) return raw;
  if (/^639\d{9}$/.test(raw)) return `+${raw}`;
  if (/^09\d{9}$/.test(raw)) return `+63${raw.slice(1)}`;
  if (/^9\d{9}$/.test(raw)) return `+63${raw}`;
  return null;
}

/** +639171234567 → 9171234567 (what the "+63" prefixed field shows). */
export function phoneNationalDigits(input) {
  const e164 = normalizePhone(input);
  return e164 ? e164.slice(3) : '';
}

/** +639171234567 → "+63 917 *** 4567" */
export function maskPhone(input) {
  const e164 = normalizePhone(input);
  if (!e164) return String(input || '');
  const digits = e164.slice(3);
  return `+63 ${digits.slice(0, 3)} *** ${digits.slice(6)}`;
}

/** " 12-3456 " → ['1','2','3','4','5','6'] (digits only, never longer than length). */
export function splitCode(text, length = CODE_LENGTH) {
  return String(text ?? '').replace(/\D/g, '').slice(0, length).split('');
}

/** 42 → "0:42" · 252 → "4:12" */
export function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

/** 42 → "42 seconds" · 120 → "2 minutes" · 3900 → "1 hour 5 minutes" */
export function describeRetry(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  if (safe < 60) return `${safe} second${safe === 1 ? '' : 's'}`;
  const minutes = Math.round(safe / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

/**
 * Wire the Contact Number field.
 * @param {{profile?: object, toast?: Function}} options
 * @returns {{refresh: Function, destroy: Function, state: object} | null}
 */
export function initPhoneField({ profile = {}, toast = () => {} } = {}) {
  const input = document.getElementById('contactNumber');
  const sendBtn = document.getElementById('phone-send');
  const statusEl = document.getElementById('phone-status');
  const verifiedEl = document.getElementById('phone-verified');
  const changeBtn = document.getElementById('phone-change');
  const codeWrap = document.getElementById('phone-code');
  const boxes = codeWrap ? [...codeWrap.querySelectorAll('.phone-code-input')] : [];
  const verifyBtn = document.getElementById('phone-code-verify');
  const errorEl = document.getElementById('phone-code-error');
  const resendBtn = document.getElementById('phone-resend');
  const expiryEl = document.getElementById('phone-expiry');
  if (!input || !sendBtn || !boxes.length) return null;

  const state = {
    verifiedPhone: profile.phoneVerified ? normalizePhone(profile.contactNumber) : null,
    verifiedAt: profile.phoneVerifiedAt || null,
    pendingPhone: null,
    resendAt: 0,
    expiresAt: 0,
    sending: false,
    verifying: false,
    ticker: null
  };

  // ---------- small DOM helpers ----------
  const setStatus = (text) => { if (statusEl) statusEl.textContent = text || ''; };
  const setError = (text) => {
    if (!errorEl) return;
    errorEl.textContent = text || '';
    errorEl.hidden = !text;
  };
  const setBusy = (button, busy) => {
    if (!button) return;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    const spinner = button.querySelector('.spinner-border');
    if (spinner) spinner.hidden = !busy;
  };

  function showVerified(on) {
    if (verifiedEl) verifiedEl.hidden = !on;
    if (changeBtn) changeBtn.hidden = !on;
    input.readOnly = Boolean(on);
    sendBtn.hidden = Boolean(on);
    if (on) input.setAttribute('aria-readonly', 'true');
    else input.removeAttribute('aria-readonly');
  }

  function showCodePanel(on) {
    if (!codeWrap) return;
    codeWrap.hidden = !on;
    if (!on) {
      boxes.forEach((box) => { box.value = ''; });
      setError('');
    }
  }

  const boxesValue = () => boxes.map((box) => box.value).join('');

  function syncVerifyButton() {
    if (!verifyBtn) return;
    verifyBtn.disabled = state.verifying || boxesValue().length !== CODE_LENGTH;
  }

  function syncSendButton() {
    const cooling = state.resendAt > Date.now();
    sendBtn.disabled = state.sending || cooling;
    sendBtn.classList.toggle('is-cooling', cooling);
    if (resendBtn) {
      resendBtn.disabled = state.sending || cooling;
      resendBtn.hidden = !state.pendingPhone;
    }
  }

  function stopTicker() {
    if (state.ticker) {
      clearInterval(state.ticker);
      state.ticker = null;
    }
  }

  // One ticker drives the resend countdown and the code expiry clock.
  function startTicker() {
    stopTicker();
    const tick = () => {
      const now = Date.now();
      if (state.pendingPhone && now >= state.expiresAt) {
        if (expiryEl) expiryEl.textContent = 'Code expired';
        if (verifyBtn) verifyBtn.disabled = true;
      } else if (state.pendingPhone && expiryEl) {
        expiryEl.textContent = `Code expires in ${formatClock((state.expiresAt - now) / 1000)}`;
      }
      const cooling = state.resendAt > now;
      if (resendBtn) resendBtn.textContent = cooling ? `Resend in ${formatClock((state.resendAt - now) / 1000)}` : 'Resend code';
      syncSendButton();
      if (!cooling) stopTicker();
    };
    tick();
    state.ticker = setInterval(tick, 1000);
  }

  function beginCooldown(seconds) {
    state.resendAt = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
    if (state.resendAt > Date.now()) startTicker();
    syncSendButton();
  }

  // ---------- network ----------
  async function post(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch {
      return {
        ok: false,
        status: 0,
        networkError: true,
        data: { error: 'Network error. Check your connection and try again.' }
      };
    }
  }

  // ---------- actions ----------
  async function sendCode() {
    const phone = normalizePhone(input.value);
    if (!phone) {
      setError('Enter a valid Philippine mobile number, e.g. 09171234567.');
      input.focus();
      return;
    }
    setError('');
    setStatus('Sending the code…');
    state.sending = true;
    setBusy(sendBtn, true);
    syncSendButton();
    try {
      const { ok, status, data, networkError } = await post('/api/profile/phone/send-code', { phone });
      if (!ok) {
        if (networkError) toast('Network error', data.error, 'exclamation-triangle');
        else if (status === 401) toast('Session expired', 'Please sign in again to verify your number.', 'exclamation-triangle');
        if (status === 429) {
          // The rate-limit message replaces the transient “Sending…” status.
          setStatus('');
          beginCooldown(data.retryAfter ?? 60);
          setError(`${data.error || 'Too many requests.'} You can try again in ${describeRetry(data.retryAfter)}.`);
          return;
        }
        setStatus('');
        setError(data.error || 'Could not send the code. Please try again.');
        return;
      }
      state.pendingPhone = data.phone || phone;
      state.expiresAt = Date.now() + (data.expiresIn || 300) * 1000;
      state.verifiedPhone = null;
      state.verifiedAt = null;
      showVerified(false);
      showCodePanel(true);
      setStatus(`Code sent to ${data.masked || maskPhone(state.pendingPhone)}`);
      if (expiryEl) expiryEl.textContent = `Code expires in ${formatClock(data.expiresIn || 300)}`;
      beginCooldown(data.resendIn ?? 60);
      syncVerifyButton();
      if (verifyBtn) verifyBtn.disabled = true;
      boxes[0].focus();
    } finally {
      state.sending = false;
      setBusy(sendBtn, false);
      syncSendButton();
    }
  }

  async function verifyCode() {
    const code = boxesValue();
    if (code.length !== CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} digits of the code.`);
      boxes[0].focus();
      return;
    }
    const phone = state.pendingPhone || normalizePhone(input.value);
    setError('');
    state.verifying = true;
    setBusy(verifyBtn, true);
    syncVerifyButton();
    try {
      const { ok, status, data, networkError } = await post('/api/profile/phone/verify-code', { phone, code });
      if (ok && data.success) {
        state.verifiedPhone = data.phone || phone;
        state.verifiedAt = data.phoneVerifiedAt || new Date().toISOString();
        state.pendingPhone = null;
        state.resendAt = 0;
        stopTicker();
        input.value = phoneNationalDigits(state.verifiedPhone);
        showCodePanel(false);
        showVerified(true);
        setStatus(`Verified ${data.masked || maskPhone(state.verifiedPhone)}`);
        toast('Phone verified', `${data.masked || maskPhone(state.verifiedPhone)} is now your verified contact number.`, 'patch-check-fill');
        return;
      }
      if (networkError) toast('Network error', data.error, 'exclamation-triangle');
      if (status === 429 && typeof data.retryAfter === 'number') {
        // The code is gone for good — start over once the cooldown allows it.
        state.pendingPhone = null;
        showCodePanel(false);
        beginCooldown(data.retryAfter);
        setStatus('');
        setError(`${data.error || 'Too many incorrect attempts.'} Try again in ${describeRetry(data.retryAfter)}.`);
        return;
      }
      const attemptsLeft = typeof data.attemptsLeft === 'number' ? data.attemptsLeft : null;
      if (attemptsLeft !== null) {
        setError(`${data.error}. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left`);
        boxes.forEach((box) => { box.value = ''; });
        boxes[0].focus();
        return;
      }
      // Expired, unknown, or a number that is not available for this account.
      setError(data.error || 'Incorrect code. Please try again.');
      state.pendingPhone = null;
      state.resendAt = 0;
      stopTicker();
      showCodePanel(false);
      setStatus('');
    } finally {
      state.verifying = false;
      setBusy(verifyBtn, false);
      syncVerifyButton();
      syncSendButton();
    }
  }

  function fill(text, from = 0) {
    const digits = splitCode(text);
    if (!digits.length) return;
    digits.forEach((digit, offset) => {
      const target = boxes[from + offset];
      if (target) target.value = digit;
    });
    const last = boxes[Math.min(from + digits.length, boxes.length - 1)];
    if (last) last.focus();
    syncVerifyButton();
  }

  // ---------- event wiring ----------
  sendBtn.addEventListener('click', () => { if (!sendBtn.disabled) sendCode(); });
  if (resendBtn) resendBtn.addEventListener('click', () => { if (!resendBtn.disabled) sendCode(); });
  if (verifyBtn) verifyBtn.addEventListener('click', () => { if (!verifyBtn.disabled) verifyCode(); });
  if (changeBtn) changeBtn.addEventListener('click', () => {
    // A different number must go through the code flow again; the saved record
    // only loses its verified flag once the new number is actually saved.
    state.verifiedPhone = null;
    state.verifiedAt = null;
    showVerified(false);
    setStatus('Enter the new number, then tap “Send code”.');
    input.focus();
  });

  boxes.forEach((box, index) => {
    box.addEventListener('input', () => {
      const digits = String(box.value).replace(/\D/g, '');
      if (digits.length > 1) {
        // Several digits landed in one box (typing fast or a paste without the
        // paste event) — spread them from here.
        box.value = '';
        fill(digits, index);
      } else {
        box.value = digits;
        if (digits && index < boxes.length - 1) boxes[index + 1].focus();
      }
      syncVerifyButton();
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !box.value && index > 0) {
        event.preventDefault();
        boxes[index - 1].value = '';
        boxes[index - 1].focus();
        syncVerifyButton();
        return;
      }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); boxes[index - 1].focus(); }
      if (event.key === 'ArrowRight' && index < boxes.length - 1) { event.preventDefault(); boxes[index + 1].focus(); }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (boxesValue().length === CODE_LENGTH && verifyBtn && !verifyBtn.disabled) verifyCode();
      }
    });
    box.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text') || '';
      if (!/\d/.test(text)) return;
      event.preventDefault();
      fill(text, index);
    });
    box.addEventListener('focus', () => box.select());
  });

  input.addEventListener('input', () => {
    setError('');
    const typed = normalizePhone(input.value);
    // A pending code belongs to the number it was sent to.
    if (state.pendingPhone && typed !== state.pendingPhone) {
      state.pendingPhone = null;
      state.resendAt = 0;
      stopTicker();
      showCodePanel(false);
      setStatus('');
      syncSendButton();
    }
    // Editing the saved number drops the badge until it is verified again.
    if (state.verifiedPhone && typed !== state.verifiedPhone) {
      state.verifiedPhone = null;
      state.verifiedAt = null;
      showVerified(false);
      setStatus('This number is not verified yet — tap “Send code” to verify it.');
    }
  });

  // ---------- initial render ----------
  if (profile.contactNumber) {
    input.value = phoneNationalDigits(profile.contactNumber) || profile.contactNumber;
  }
  if (state.verifiedPhone) {
    input.value = phoneNationalDigits(state.verifiedPhone);
    showVerified(true);
    setStatus(`Verified ${maskPhone(state.verifiedPhone)}`);
  } else {
    showVerified(false);
  }
  showCodePanel(false);
  syncSendButton();
  syncVerifyButton();
  if (resendBtn) resendBtn.hidden = true;

  return {
    state,
    /** Re-sync the badge with what the server stored (call after saving the form). */
    refresh(nextProfile = {}) {
      const verified = Boolean(nextProfile.phoneVerified);
      state.verifiedPhone = verified ? normalizePhone(nextProfile.contactNumber) : null;
      state.verifiedAt = nextProfile.phoneVerifiedAt || null;
      if (state.verifiedPhone) {
        input.value = phoneNationalDigits(state.verifiedPhone);
        showVerified(true);
        setStatus(`Verified ${maskPhone(state.verifiedPhone)}`);
      } else {
        showVerified(false);
        setStatus('');
      }
    },
    destroy() { stopTicker(); }
  };
}
