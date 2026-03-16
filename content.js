// SVITLANA — content.js
// Runs in isolated world (document_idle).
// Receives WS/XHR events from injected.js via CustomEvents.

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let enabled              = false;
let debugEnabled         = false;
let emergency            = false;
let autoResume           = true;
let rateLimitUsed        = 0;
let rateLimitMax         = 6;
let wsExpectingNewRows   = false;
let cooldownUntil        = 0;
let cooldownTimer        = null;
let ratePauseActive      = false;
let ratePauseTimer       = null;
let newItemsSinceClear   = 0;    // clear seen every 10 WS-delivered items
const COOLDOWN_MS        = 30000;
const SEEN_CLEAR_AFTER   = 10;
const seen               = new Set();
const LOG                = [];

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, event, data = {}) {
  const entry = { ts: Date.now(), level, event, data };
  LOG.push(entry);
  if (LOG.length > 200) LOG.shift();

  // info/warn/error always print; debug only when debug mode is on
  if (level !== 'debug' || debugEnabled) {
    const detail = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[SVITLANA][${level}] ${event}${detail}`);
  }

  if (debugEnabled) {
    chrome.storage.local.set({ sniper_log: [...LOG] });
  }
}

function flushLog() {
  chrome.storage.local.set({ sniper_log: [...LOG] });
}

// ─── Storage / state sync ────────────────────────────────────────────────────

function loadState() {
  chrome.storage.local.get(
    ['enabled', 'debug', 'emergency', 'auto_resume'],
    (result) => {
      enabled      = !!result.enabled;
      debugEnabled = !!result.debug;
      emergency    = !!result.emergency;
      autoResume   = result.auto_resume !== false;
      updateOverlay();
      log('info', 'state_loaded', { enabled, debugEnabled, emergency, autoResume });
    }
  );
}

function saveState(patch) {
  chrome.storage.local.set(patch);
}

chrome.storage.onChanged.addListener((changes) => {
  if ('enabled' in changes) {
    enabled = changes.enabled.newValue;
    if (enabled && !emergency) activateLiveSearch();
    else if (!enabled) deactivateLiveSearch();
    log('info', 'enabled_changed', { enabled });
    updateOverlay();
  }
  if ('debug' in changes) {
    debugEnabled = changes.debug.newValue;
    if (debugEnabled) flushLog();
  }
  if ('emergency' in changes) {
    emergency = changes.emergency.newValue;
    if (emergency) enabled = false;
    log('warn', 'emergency_changed', { emergency });
    updateOverlay();
  }
  if ('rate_used' in changes) {
    rateLimitUsed = changes.rate_used.newValue || 0;
    updateOverlay();
  }
  if ('auto_resume' in changes) {
    autoResume = changes.auto_resume.newValue !== false;
    log('info', 'auto_resume_changed', { autoResume });
  }
});

// ─── Emergency stop ───────────────────────────────────────────────────────────

function triggerEmergencyStop(reason) {
  // Cancel any pending rate-limit auto-resume
  ratePauseActive = false;
  if (ratePauseTimer) { clearTimeout(ratePauseTimer); ratePauseTimer = null; }

  emergency = true;
  enabled   = false;
  saveState({ enabled: false, emergency: true, emergency_reason: reason, emergency_ts: Date.now(), rate_pause_until: 0 });
  updateOverlay();
  log('error', 'emergency_stop', { reason });
}

// ─── Rate-limit display (no sniping pause) ───────────────────────────────────
// We don't disable sniping on rate limits — our extension makes no API calls,
// only clicks a DOM button. Disabling would cause items to be added to `seen`
// and permanently missed. Just show a countdown overlay.

function triggerRatePause(restrictionSeconds) {
  const secs = restrictionSeconds > 0 ? restrictionSeconds : 10;
  ratePauseActive = true;
  updateOverlay(); // show ⏳ WAITING immediately

  // Reset timer if called multiple times (multiple 429s)
  if (ratePauseTimer) clearTimeout(ratePauseTimer);

  const pauseStartedAt = Date.now();
  saveState({ rate_pause_until: pauseStartedAt + secs * 1000, rate_pause_started_at: pauseStartedAt });

  log('warn', 'rate_paused', { restrictionS: secs, autoResume });
  startRatePauseCountdown(secs);

  ratePauseTimer = setTimeout(() => {
    ratePauseTimer = null;
    if (!ratePauseActive) return; // user manually stopped during the wait
    ratePauseActive = false;
    saveState({ rate_pause_until: 0 });
    if (emergency) return;
    log('info', 'rate_pause_ended', { autoResume });
    if (autoResume) {
      enabled = true;
      saveState({ enabled: true, emergency: false });
      activateLiveSearch();
    }
    updateOverlay();
  }, secs * 1000);
}

function warnRateLimit(used) {
  rateLimitUsed = used;
  saveState({ rate_used: used, rate_max: rateLimitMax });
  updateOverlay();
  log('warn', 'rate_limit_warning', { used, max: rateLimitMax });
}

// ─── Click history ────────────────────────────────────────────────────────────

function recordClickHistory(action) {
  chrome.storage.local.get('click_history', ({ click_history }) => {
    const history = Array.isArray(click_history) ? click_history : [];
    history.unshift(action);
    if (history.length > 25) history.length = 25;
    chrome.storage.local.set({ click_history: history });
  });
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────

function isOnCooldown() {
  return Date.now() < cooldownUntil;
}

function startCooldown() {
  cooldownUntil = Date.now() + COOLDOWN_MS;
  log('info', 'cooldown_started', { ms: COOLDOWN_MS });
  startCooldownDisplay();
}

function startCooldownDisplay() {
  if (cooldownTimer) clearInterval(cooldownTimer);
  const label   = overlayEl?.querySelector('#svitlana-cooldown');
  const skipBtn = overlayEl?.querySelector('#svitlana-skip');
  if (!label) return;

  cooldownTimer = setInterval(() => {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      label.textContent    = '';
      label.style.display  = 'none';
      if (skipBtn) skipBtn.style.display = 'none';
    } else {
      label.style.display  = 'block';
      label.textContent    = `Cooldown ${remaining}s`;
      if (skipBtn) skipBtn.style.display = 'block';
    }
  }, 250);
}

let ratePauseInterval  = null;
let ratePauseEndsAt    = 0;

function startRatePauseCountdown(seconds) {
  ratePauseEndsAt = Date.now() + seconds * 1000;
  const label = overlayEl?.querySelector('#svitlana-rate-pause');
  if (!label) return;
  if (ratePauseInterval) clearInterval(ratePauseInterval);

  label.style.display = 'block';
  ratePauseInterval = setInterval(() => {
    const remaining = Math.ceil((ratePauseEndsAt - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(ratePauseInterval);
      ratePauseInterval = null;
      label.textContent   = '';
      label.style.display = 'none';
    } else {
      label.textContent = `⚠ Rate limited ${remaining}s`;
    }
  }, 500);
}

// ─── Events from injected.js (MAIN world) ────────────────────────────────────

window.addEventListener('svitlana-ws', (e) => {
  const { type, count, url } = e.detail;
  if (type === 'open') {
    log('info', 'live_search_ws_open', { url });
  } else if (type === 'new_items') {
    wsExpectingNewRows = true;
    setTimeout(() => { wsExpectingNewRows = false; }, 25000);
    scheduleItemScan();

    // Track items to know when to clear seen
    newItemsSinceClear += count;
    log('info', 'ws_new_items', { count, totalSinceClear: newItemsSinceClear });
    if (newItemsSinceClear >= SEEN_CLEAR_AFTER) {
      seen.clear();
      newItemsSinceClear = 0;
      log('info', 'seen_cleared', { reason: `${SEEN_CLEAR_AFTER}_items_threshold` });
    }
  } else if (type === 'close') {
    log('info', 'live_search_ws_close', {});
  }
});

window.addEventListener('svitlana-rate', (e) => {
  const { status, accountState, accountLimit } = e.detail;

  // Parse the max from the limit header (format: "hits:window:restriction,...")
  if (accountLimit) {
    const parsed = parseInt(accountLimit.split(':')[0], 10);
    if (parsed > 0) rateLimitMax = parsed;
  }

  if (accountState) {
    // State can be multi-rule: "hits:window:restriction,hits:window:restriction"
    // Find the highest active restriction across all rules
    let used           = 0;
    let maxRestriction = 0;
    for (const rule of accountState.split(',')) {
      const parts = rule.trim().split(':').map(Number);
      if (parts[0] > used) used = parts[0];
      if (parts[2] > maxRestriction) maxRestriction = parts[2];
    }

    rateLimitUsed = used;
    saveState({ rate_used: used, rate_max: rateLimitMax });
    updateOverlay();

    if (maxRestriction > 0) {
      // Server confirmed active restriction window — pause until it clears
      log('warn', 'rate_restricted', { status, restrictionS: maxRestriction, state: accountState });
      triggerRatePause(maxRestriction);
    } else if (status === 429 || status === 403) {
      // 429 but no active restriction in headers yet — log only, page self-recovers
      log('warn', 'rate_limited', { status, used, max: rateLimitMax });
    } else if (used >= rateLimitMax - 2) {
      warnRateLimit(used);
    } else {
      log('debug', 'rate_state', { state: accountState, used, max: rateLimitMax });
    }
  } else if (status === 429 || status === 403) {
    log('warn', 'rate_limited_no_headers', { status });
  }
});

// ─── Live search button helpers ───────────────────────────────────────────────

function findLiveSearchBtn(text) {
  return [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim().toLowerCase().includes(text.toLowerCase())
  ) || null;
}

function activateLiveSearch() {
  if (location.href.endsWith('/live')) return; // already active
  const btn = findLiveSearchBtn('activate live search');
  if (btn) { btn.click(); log('info', 'ls_btn_clicked', { action: 'activate' }); }
}

function deactivateLiveSearch() {
  if (!location.href.endsWith('/live')) return; // already inactive
  const btn = findLiveSearchBtn('deactivate live search');
  if (btn) { btn.click(); log('info', 'ls_btn_clicked', { action: 'deactivate' }); }
}

// ─── Live search on/off detection (URL-based) ────────────────────────────────

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href === lastUrl) return;
  const wasLive = lastUrl.endsWith('/live');
  const isLive  = location.href.endsWith('/live');
  lastUrl = location.href;
  if (isLive && !wasLive) {
    log('info', 'live_search_activated', {});
    if (!emergency) {
      enabled = true;
      saveState({ enabled: true, emergency: false });
      updateOverlay();
    }
  } else if (!isLive && wasLive) {
    wsExpectingNewRows = false;
    log('info', 'live_search_deactivated', {});
    enabled = false;
    saveState({ enabled: false });
    updateOverlay();
  }
}).observe(document, { subtree: true, childList: true });

if (location.href.endsWith('/live')) {
  log('info', 'live_search_activated', { via: 'direct_url' });
  if (!emergency) {
    enabled = true;
    saveState({ enabled: true, emergency: false });
  }
}

// ─── Sound alert ─────────────────────────────────────────────────────────────

function playAlert() {
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch (_) {}
}

// ─── Sniping logic ───────────────────────────────────────────────────────────

function handleNewResultset(row) {
  const id = row.getAttribute('data-id');
  if (!id) return;

  log('debug', 'new_row_seen', { id: id.slice(0, 12) });

  if (!enabled || emergency) {
    log('debug', 'skipped_disabled', { enabled, emergency });
    return;
  }
  if (seen.has(id)) {
    log('debug', 'skipped_dupe', { id: id.slice(0, 12) });
    return;
  }
  if (isOnCooldown()) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    log('info', 'skipped_cooldown', { remainingS: remaining });
    seen.add(id);
    return;
  }

  seen.add(id);

  const name     = row.querySelector('.itemName .lc')?.textContent?.trim() || id.slice(0, 8);
  const priceEl  = row.querySelector('[data-field="price"] span:not(.price-label):not(.currency-image)');
  const currency = row.querySelector('.currency-text span')?.textContent?.trim() || '';
  const price    = priceEl?.textContent?.trim() || '?';
  const priceStr = `${price} ${currency}`.trim();

  // If "In demand. Teleport anyway?" is already rendered, click it directly —
  // skips one round-trip vs clicking Travel to Hideout and waiting for the dialog.
  const scope      = row.closest('.resultset') || row;
  const confirmBtn = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent.includes('Teleport anyway')
  );
  const btn = confirmBtn || row.querySelector('.btns .direct-btn');

  if (!btn) {
    log('warn', 'btn_not_found', { id: id.slice(0, 12) });
    return;
  }

  playAlert();
  btn.click();
  log('info', 'clicked', { name, price: priceStr, via: confirmBtn ? 'confirm_direct' : 'direct_btn' });

  // If we clicked Travel to Hideout (not the confirm button), watch in case
  // GGG raises the "In demand" dialog after the click.
  if (!confirmBtn) watchForConfirmation(row);

  startCooldown();

  const action = { name, price: priceStr, ts: Date.now() };
  recordClickHistory(action);
  updateOverlayLastAction(action);
}

// ─── In-demand confirmation ───────────────────────────────────────────────────
// After clicking Travel to Hideout, GGG may show "⚠ In demand. Teleport anyway?"
// Watch for it and auto-click immediately.

function watchForConfirmation(row) {
  // Search in .resultset (parent of row) — GGG may add the confirm button
  // as a sibling element, not inside row itself.
  const scope = row.closest('.resultset') || row;

  function findConfirmBtn() {
    return [...scope.querySelectorAll('button')].find(
      (b) => b.textContent.includes('Teleport anyway')
    ) || null;
  }

  // Check immediately (may already be rendered)
  const immediate = findConfirmBtn();
  if (immediate) {
    immediate.click();
    log('info', 'confirm_clicked', { immediate: true });
    return;
  }

  // Watch for DOM insertion OR CSS visibility changes (class/style attribute toggled)
  const obs = new MutationObserver(() => {
    const btn = findConfirmBtn();
    if (!btn) return;
    obs.disconnect();
    btn.click();
    log('info', 'confirm_clicked', {});
  });
  obs.observe(scope, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });
  setTimeout(() => obs.disconnect(), 5000);
}

// ─── Polling fallback ────────────────────────────────────────────────────────
// After a WS event, poll DOM for unseen rows in case MutationObserver
// fires before/after wsExpectingNewRows is set (race condition).

let scanTimer = null;

function scheduleItemScan() {
  if (scanTimer) clearInterval(scanTimer);
  let attempts = 0;
  scanTimer = setInterval(() => {
    attempts++;
    if (attempts > 20 || !wsExpectingNewRows) {  // up to 4s (20 × 200ms)
      clearInterval(scanTimer);
      scanTimer = null;
      return;
    }
    if (!enabled || emergency || isOnCooldown()) return;
    const results = document.querySelector('.results');
    if (!results) return;
    for (const row of results.querySelectorAll('.row[data-id]')) {
      const id = row.getAttribute('data-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      handleNewResultset(row);
      wsExpectingNewRows = false;
      clearInterval(scanTimer);
      scanTimer = null;
      return;
    }
  }, 200);
}

// ─── MutationObserver ────────────────────────────────────────────────────────

let resultsObserver  = null;
let currentResultsEl = null;

function attachResultsObserver(resultsEl) {
  // Disconnect previous observer if pointing to a stale node
  if (resultsObserver) {
    resultsObserver.disconnect();
    resultsObserver = null;
  }
  currentResultsEl = resultsEl;

  resultsObserver = new MutationObserver((mutations) => {
    let clickedThisBatch = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;

        if (debugEnabled) {
          const cls = [...(node.classList || [])].join(' ') || '—';
          const id  = node.getAttribute?.('data-id')?.slice(0, 8) || '';
          console.log(`[SVITLANA][dom] ADDED ${node.tagName} .${cls}${id ? ' #' + id : ''}`);
        }

        // Vue adds .resultset first (empty), then .row inside it separately.
        // Watch for the .row[data-id] itself being added (subtree: true catches this).
        const row = node.classList?.contains('row') && node.hasAttribute('data-id')
          ? node
          : node.querySelector?.('.row[data-id]');
        const id = row?.getAttribute('data-id');
        if (!id || seen.has(id)) continue;

        if (!clickedThisBatch && wsExpectingNewRows && enabled && !emergency && !isOnCooldown()) {
          wsExpectingNewRows = false;
          handleNewResultset(row);
          clickedThisBatch = true;
        } else {
          // Only permanently mark as seen for non-retriable reasons.
          // If disabled/emergency, don't mark seen — the poll will retry.
          const retriable = !enabled || emergency;
          if (!retriable) seen.add(id);
          log('debug', 'batch_extra_skipped', { id: id.slice(0, 12), retriable });
        }
      }
    }
  });

  resultsObserver.observe(resultsEl, { childList: true, subtree: true });
  log('info', 'observer_attached', {});
}

function watchForResults() {
  // Persistent body observer — re-attaches whenever .results is replaced (SPA navigation)
  const bodyObserver = new MutationObserver(() => {
    const el = document.querySelector('.results');
    if (el && el !== currentResultsEl) {
      attachResultsObserver(el);
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  // Attach immediately if already present
  const existing = document.querySelector('.results');
  if (existing) {
    attachResultsObserver(existing);
  } else {
    log('info', 'waiting_for_results', {});
  }
}

// ─── In-page overlay ─────────────────────────────────────────────────────────

let overlayEl = null;

function createOverlay() {
  const style = document.createElement('style');
  style.textContent = `
    #svitlana-overlay {
      position: fixed;
      z-index: 2147483647;
      bottom: 24px;
      right: 24px;
      width: 220px;
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid #c8a84b;
      border-radius: 6px;
      font-family: 'Segoe UI', sans-serif;
      font-size: 13px;
      color: #d0c4a0;
      box-shadow: 0 4px 20px rgba(0,0,0,0.7);
      user-select: none;
    }
    #svitlana-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 6px;
      border-bottom: 1px solid #3a3020;
      cursor: grab;
    }
    #svitlana-header:active { cursor: grabbing; }
    #svitlana-title { font-weight: bold; color: #c8a84b; font-size: 12px; letter-spacing: 0.5px; }
    #svitlana-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #4caf50; box-shadow: 0 0 6px #4caf50; flex-shrink: 0;
    }
    #svitlana-dot.red    { background: #e53935; box-shadow: 0 0 6px #e53935; }
    #svitlana-dot.yellow { background: #fbc02d; box-shadow: 0 0 6px #fbc02d; }
    #svitlana-last {
      padding: 5px 10px 2px;
      font-size: 11px;
      color: #7a6a50;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #svitlana-cooldown {
      display: none;
      padding: 0 10px 2px;
      font-size: 10px;
      color: #fbc02d;
    }
    #svitlana-rate-pause {
      display: none;
      padding: 0 10px 2px;
      font-size: 10px;
      color: #e57373;
    }
    #svitlana-skip {
      display: none;
      width: calc(100% - 16px);
      margin: 0 8px 6px;
      padding: 4px;
      background: #1a2a3a;
      border: 1px solid #2a5a7a;
      border-radius: 4px;
      color: #80c0e0;
      font-size: 11px;
      font-weight: bold;
      cursor: pointer;
      letter-spacing: 0.5px;
      transition: background 0.15s;
    }
    #svitlana-skip:hover { background: #1e3a50; }
    #svitlana-rate-wrap { padding: 2px 10px 5px; }
    #svitlana-rate-label { font-size: 10px; color: #6a5a40; margin-bottom: 3px; }
    #svitlana-rate-bar-bg { height: 4px; background: #2a2010; border-radius: 2px; overflow: hidden; }
    #svitlana-rate-bar { height: 100%; width: 0%; background: #c8a84b; border-radius: 2px; transition: width 0.3s, background 0.3s; }
    #svitlana-btn {
      display: block;
      width: calc(100% - 16px);
      margin: 0 8px 8px;
      padding: 6px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      letter-spacing: 1px;
      cursor: pointer;
      transition: background 0.15s;
    }
    #svitlana-btn.stop  { background: #8b1a1a; border: 1px solid #c0392b; color: #ffcdd2; }
    #svitlana-btn.stop:hover { background: #c0392b; }
    #svitlana-btn.start { background: #1a3a1a; border: 1px solid #2d6a2d; color: #a0d0a0; }
    #svitlana-btn.start:hover { background: #2d5a2d; }
    #svitlana-btn.wait  { background: #2a1e00; border: 1px solid #7a6020; color: #fbc02d; cursor: default; }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'svitlana-overlay';
  el.innerHTML = `
    <div id="svitlana-header">
      <span id="svitlana-title">SVITLANA</span>
      <span id="svitlana-dot"></span>
    </div>
    <div id="svitlana-last">—</div>
    <div id="svitlana-cooldown"></div>
    <div id="svitlana-rate-pause"></div>
    <button id="svitlana-skip">⚡ Skip Cooldown</button>
    <div id="svitlana-rate-wrap">
      <div id="svitlana-rate-label">Rate <span id="svitlana-rate-text">0/6</span></div>
      <div id="svitlana-rate-bar-bg"><div id="svitlana-rate-bar"></div></div>
    </div>
    <button id="svitlana-btn" class="stop">■ STOP</button>
  `;
  document.body.appendChild(el);
  overlayEl = el;

  // Drag
  const header = el.querySelector('#svitlana-header');
  let dragging = false, ox = 0, oy = 0;
  header.addEventListener('mousedown', (e) => {
    dragging = true;
    ox = e.clientX - el.getBoundingClientRect().left;
    oy = e.clientY - el.getBoundingClientRect().top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    el.style.left   = (e.clientX - ox) + 'px';
    el.style.top    = (e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    saveState({ overlay_pos: { left: el.style.left, top: el.style.top } });
  });

  chrome.storage.local.get('overlay_pos', ({ overlay_pos }) => {
    if (overlay_pos?.left) {
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
      el.style.left   = overlay_pos.left;
      el.style.top    = overlay_pos.top;
    }
  });

  el.querySelector('#svitlana-btn').addEventListener('click', () => {
    if (ratePauseActive || (enabled && !emergency)) {
      // STOP / cancel waiting → emergency stop
      ratePauseActive = false;
      if (ratePauseTimer) { clearTimeout(ratePauseTimer); ratePauseTimer = null; }
      emergency = true;
      enabled   = false;
      saveState({ enabled: false, emergency: true, emergency_reason: 'overlay_button', emergency_ts: Date.now(), rate_pause_until: 0 });
      log('warn', 'emergency_stop', { reason: 'overlay_button' });
      deactivateLiveSearch();
      updateOverlay();
    } else {
      // START
      emergency = false;
      enabled   = true;
      saveState({ enabled: true, emergency: false, emergency_reason: null });
      log('info', 'resumed', { via: 'overlay_button' });
      activateLiveSearch();
      updateOverlay();
    }
  });

  el.querySelector('#svitlana-skip').addEventListener('click', () => {
    cooldownUntil = 0;
    if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    const label   = overlayEl.querySelector('#svitlana-cooldown');
    const skipBtn = overlayEl.querySelector('#svitlana-skip');
    if (label)   { label.textContent = ''; label.style.display = 'none'; }
    if (skipBtn) { skipBtn.style.display = 'none'; }
    log('info', 'cooldown_skipped', {});
  });

  updateOverlay();
}

function updateOverlay() {
  if (!overlayEl) return;

  const dot = overlayEl.querySelector('#svitlana-dot');
  const btn = overlayEl.querySelector('#svitlana-btn');

  if (emergency) {
    dot.className   = 'red';
    btn.textContent = '▶ START';
    btn.className   = 'start';
  } else if (ratePauseActive) {
    dot.className   = 'yellow';
    btn.textContent = '⏳ WAITING';
    btn.className   = 'wait';
  } else if (enabled) {
    dot.className   = rateLimitUsed >= rateLimitMax - 1 ? 'yellow' : '';
    btn.textContent = '■ STOP';
    btn.className   = 'stop';
  } else {
    dot.className   = 'red';
    btn.textContent = '▶ START';
    btn.className   = 'start';
  }

  updateOverlayRate();
}

function updateOverlayRate() {
  if (!overlayEl) return;
  const pct  = rateLimitMax > 0 ? (rateLimitUsed / rateLimitMax) * 100 : 0;
  const bar  = overlayEl.querySelector('#svitlana-rate-bar');
  const text = overlayEl.querySelector('#svitlana-rate-text');
  bar.style.width      = pct + '%';
  bar.style.background = pct >= 80 ? '#e53935' : pct >= 60 ? '#fbc02d' : '#c8a84b';
  text.textContent     = `${rateLimitUsed}/${rateLimitMax}`;
}

function updateOverlayLastAction(action) {
  if (!overlayEl) return;
  const time = new Date(action.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  overlayEl.querySelector('#svitlana-last').textContent = `${action.name} ${action.price} ${time}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState();
createOverlay();
watchForResults();
