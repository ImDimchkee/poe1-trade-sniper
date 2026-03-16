// PoE Trade Sniper — content.js
// Runs in isolated world (document_idle).
// Receives WS/XHR events from injected.js via CustomEvents.

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let enabled              = false;
let debugEnabled         = false;
let emergency            = false;
let rateLimitUsed        = 0;
let rateLimitMax         = 6;
let wsExpectingNewRows   = false;
let cooldownUntil        = 0;
let cooldownTimer        = null;
let newItemsSinceClear   = 0;    // clear seen every 10 WS-delivered items
const COOLDOWN_MS        = 15000;
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
    fn(`[PoE Sniper][${level}] ${event}${detail}`);
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
    ['enabled', 'debug', 'emergency'],
    (result) => {
      enabled      = result.enabled !== false;
      debugEnabled = !!result.debug;
      emergency    = !!result.emergency;
      updateOverlay();
      log('info', 'state_loaded', { enabled, debugEnabled, emergency });
    }
  );
}

function saveState(patch) {
  chrome.storage.local.set(patch);
}

chrome.storage.onChanged.addListener((changes) => {
  if ('enabled' in changes) {
    enabled = changes.enabled.newValue;
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
});

// ─── Emergency stop ───────────────────────────────────────────────────────────

function triggerEmergencyStop(reason) {
  emergency = true;
  enabled   = false;
  saveState({ enabled: false, emergency: true, emergency_reason: reason, emergency_ts: Date.now() });
  updateOverlay();
  log('error', 'emergency_stop', { reason });
}

// ─── Rate-limit auto-pause ────────────────────────────────────────────────────
// 429 pauses sniping for the restriction window then auto-resumes.
// Does not require manual intervention.

let ratePauseTimer = null;

function triggerRatePause(restrictionSeconds) {
  const pauseMs = (restrictionSeconds > 0 ? restrictionSeconds : 60) * 1000;
  enabled = false;
  saveState({ enabled: false });
  updateOverlay();
  log('warn', 'rate_paused', { pauseMs });

  if (ratePauseTimer) clearTimeout(ratePauseTimer);
  startRatePauseCountdown(Math.ceil(pauseMs / 1000));

  ratePauseTimer = setTimeout(() => {
    ratePauseTimer = null;
    if (!emergency) {
      enabled = true;
      saveState({ enabled: true });
      updateOverlay();
      log('info', 'rate_pause_ended', {});
    }
  }, pauseMs);
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
  const label = overlayEl?.querySelector('#poe-sniper-cooldown');
  if (!label) return;

  cooldownTimer = setInterval(() => {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      label.textContent = '';
      label.style.display = 'none';
    } else {
      label.style.display = 'block';
      label.textContent = `Cooldown ${remaining}s`;
    }
  }, 250);
}

let ratePauseInterval  = null;
let ratePauseEndsAt    = 0;

function startRatePauseCountdown(seconds) {
  ratePauseEndsAt = Date.now() + seconds * 1000;
  const label = overlayEl?.querySelector('#poe-sniper-cooldown');
  if (!label) return;
  if (ratePauseInterval) clearInterval(ratePauseInterval);

  ratePauseInterval = setInterval(() => {
    const remaining = Math.ceil((ratePauseEndsAt - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(ratePauseInterval);
      ratePauseInterval = null;
      label.textContent = '';
      label.style.display = 'none';
    } else {
      label.style.display = 'block';
      label.textContent = `Rate limited ${remaining}s`;
      label.style.color = '#e53935';
    }
  }, 500);
}

// ─── Events from injected.js (MAIN world) ────────────────────────────────────

window.addEventListener('poe-sniper-ws', (e) => {
  const { type, count, url } = e.detail;
  if (type === 'open') {
    log('info', 'live_search_ws_open', { url });
  } else if (type === 'new_items') {
    wsExpectingNewRows = true;
    setTimeout(() => { wsExpectingNewRows = false; }, 25000);

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

window.addEventListener('poe-sniper-rate', (e) => {
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

  if (!wsExpectingNewRows) {
    log('debug', 'skipped_not_ws', { id: id.slice(0, 12) });
    return;
  }
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

  const btn = row.querySelector('.btns .direct-btn');
  if (!btn) {
    log('warn', 'btn_not_found', { id: id.slice(0, 12) });
    return;
  }

  const name     = row.querySelector('.itemName .lc')?.textContent?.trim() || id.slice(0, 8);
  const priceEl  = row.querySelector('[data-field="price"] span:not(.price-label):not(.currency-image)');
  const currency = row.querySelector('.currency-text span')?.textContent?.trim() || '';
  const price    = priceEl?.textContent?.trim() || '?';
  const priceStr = `${price} ${currency}`.trim();

  playAlert();
  btn.click();
  startCooldown();

  const action = { name, price: priceStr, ts: Date.now() };
  recordClickHistory(action);
  updateOverlayLastAction(action);
  log('info', 'clicked', { name, price: priceStr });
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
          console.log(`[PoE Sniper][dom] ADDED ${node.tagName} .${cls}${id ? ' #' + id : ''}`);
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
          seen.add(id);
          log('debug', 'batch_extra_skipped', { id: id.slice(0, 12) });
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
    #poe-sniper-overlay {
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
    #poe-sniper-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 6px;
      border-bottom: 1px solid #3a3020;
      cursor: grab;
    }
    #poe-sniper-header:active { cursor: grabbing; }
    #poe-sniper-title { font-weight: bold; color: #c8a84b; font-size: 12px; letter-spacing: 0.5px; }
    #poe-sniper-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #4caf50; box-shadow: 0 0 6px #4caf50; flex-shrink: 0;
    }
    #poe-sniper-dot.red    { background: #e53935; box-shadow: 0 0 6px #e53935; }
    #poe-sniper-dot.yellow { background: #fbc02d; box-shadow: 0 0 6px #fbc02d; }
    #poe-sniper-last {
      padding: 5px 10px 2px;
      font-size: 11px;
      color: #7a6a50;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #poe-sniper-cooldown {
      display: none;
      padding: 0 10px 4px;
      font-size: 10px;
      color: #fbc02d;
    }
    #poe-sniper-rate-wrap { padding: 2px 10px 5px; }
    #poe-sniper-rate-label { font-size: 10px; color: #6a5a40; margin-bottom: 3px; }
    #poe-sniper-rate-bar-bg { height: 4px; background: #2a2010; border-radius: 2px; overflow: hidden; }
    #poe-sniper-rate-bar { height: 100%; width: 0%; background: #c8a84b; border-radius: 2px; transition: width 0.3s, background 0.3s; }
    #poe-sniper-btn {
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
    #poe-sniper-btn.stop  { background: #8b1a1a; border: 1px solid #c0392b; color: #ffcdd2; }
    #poe-sniper-btn.stop:hover { background: #c0392b; }
    #poe-sniper-btn.start { background: #1a3a1a; border: 1px solid #2d6a2d; color: #a0d0a0; }
    #poe-sniper-btn.start:hover { background: #2d5a2d; }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'poe-sniper-overlay';
  el.innerHTML = `
    <div id="poe-sniper-header">
      <span id="poe-sniper-title">PoE Sniper</span>
      <span id="poe-sniper-dot"></span>
    </div>
    <div id="poe-sniper-last">—</div>
    <div id="poe-sniper-cooldown"></div>
    <div id="poe-sniper-rate-wrap">
      <div id="poe-sniper-rate-label">Rate <span id="poe-sniper-rate-text">0/6</span></div>
      <div id="poe-sniper-rate-bar-bg"><div id="poe-sniper-rate-bar"></div></div>
    </div>
    <button id="poe-sniper-btn" class="stop">■ STOP</button>
  `;
  document.body.appendChild(el);
  overlayEl = el;

  // Drag
  const header = el.querySelector('#poe-sniper-header');
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

  el.querySelector('#poe-sniper-btn').addEventListener('click', () => {
    if (enabled && !emergency) {
      emergency = true;
      enabled   = false;
      saveState({ enabled: false, emergency: true, emergency_reason: 'overlay_button', emergency_ts: Date.now() });
      log('warn', 'emergency_stop', { reason: 'overlay_button' });
      deactivateLiveSearch();
      updateOverlay();
    } else {
      emergency = false;
      enabled   = true;
      saveState({ enabled: true, emergency: false, emergency_reason: null });
      log('info', 'resumed', { via: 'overlay_button' });
      activateLiveSearch();
      updateOverlay();
    }
  });

  updateOverlay();
}

function updateOverlay() {
  if (!overlayEl) return;

  const dot = overlayEl.querySelector('#poe-sniper-dot');
  const btn = overlayEl.querySelector('#poe-sniper-btn');

  if (emergency) {
    dot.className = 'red';
  } else if (rateLimitUsed >= rateLimitMax - 1) {
    dot.className = 'yellow';
  } else if (enabled) {
    dot.className = '';
  } else {
    dot.className = 'red';
  }

  if (enabled && !emergency) {
    btn.textContent = '■ STOP';
    btn.className   = 'stop';
  } else {
    btn.textContent = '▶ START';
    btn.className   = 'start';
  }

  updateOverlayRate();
}

function updateOverlayRate() {
  if (!overlayEl) return;
  const pct  = rateLimitMax > 0 ? (rateLimitUsed / rateLimitMax) * 100 : 0;
  const bar  = overlayEl.querySelector('#poe-sniper-rate-bar');
  const text = overlayEl.querySelector('#poe-sniper-rate-text');
  bar.style.width      = pct + '%';
  bar.style.background = pct >= 80 ? '#e53935' : pct >= 60 ? '#fbc02d' : '#c8a84b';
  text.textContent     = `${rateLimitUsed}/${rateLimitMax}`;
}

function updateOverlayLastAction(action) {
  if (!overlayEl) return;
  const time = new Date(action.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  overlayEl.querySelector('#poe-sniper-last').textContent = `${action.name} ${action.price} ${time}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState();
createOverlay();
watchForResults();
