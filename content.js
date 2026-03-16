// PoE Trade Sniper — content.js
// Runs in isolated world (document_idle).
// Receives WS/XHR events from injected.js via CustomEvents.

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let enabled = true;
let debugEnabled = false;
let emergency = false;
let rateLimitUsed = 0;
let rateLimitMax = 6;
let wsExpectingNewRows = false; // only click when triggered by live search WS
const seen = new Set();
const LOG = [];

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, event, data = {}) {
  const entry = { ts: Date.now(), level, event, data };
  LOG.push(entry);
  if (LOG.length > 200) LOG.shift();
  if (debugEnabled) {
    chrome.storage.local.set({ sniper_log: [...LOG] });
    console.log(`[PoE Sniper][${level}] ${event}`, data);
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
      enabled   = result.enabled !== false;
      debugEnabled = !!result.debug;
      emergency = !!result.emergency;
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
    if (debugEnabled) flushLog(); // flush in-memory log immediately on enable
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

function warnRateLimit(used) {
  rateLimitUsed = used;
  saveState({ rate_used: used, rate_max: rateLimitMax });
  updateOverlay();
  log('warn', 'rate_limit_warning', { used, max: rateLimitMax });
}

// ─── Events from injected.js (MAIN world) ────────────────────────────────────

window.addEventListener('poe-sniper-ws', (e) => {
  const { type, count, url } = e.detail;
  if (type === 'open') {
    log('info', 'live_search_ws_open', { url });
  } else if (type === 'new_items') {
    wsExpectingNewRows = true;
    // Safety: clear flag after 8s in case DOM update never arrives
    setTimeout(() => { wsExpectingNewRows = false; }, 8000);
    log('info', 'ws_new_items', { count });
  } else if (type === 'close') {
    log('info', 'live_search_ws_close', {});
  }
});

window.addEventListener('poe-sniper-rate', (e) => {
  const { status, accountState, accountLimit } = e.detail;

  if (status === 429 || status === 403) {
    triggerEmergencyStop('http_' + status);
    log('error', 'rate_limited', { status });
    return;
  }

  if (accountLimit) {
    rateLimitMax = parseInt(accountLimit.split(':')[0], 10) || 6;
  }
  if (accountState) {
    const parts      = accountState.split(':').map(Number);
    const used       = parts[0];
    const banSeconds = parts[2];
    rateLimitUsed    = used;
    saveState({ rate_used: used, rate_max: rateLimitMax });
    updateOverlay();

    if (banSeconds > 0) {
      triggerEmergencyStop('rate_limit_ban');
      log('error', 'rate_ban_active', { banSeconds, state: accountState });
    } else if (used >= rateLimitMax - 1) {
      warnRateLimit(used);
    } else {
      log('debug', 'rate_state', { state: accountState, used });
    }
  }
});

// ─── Live search on/off detection (URL-based) ────────────────────────────────

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href === lastUrl) return;
  const wasLive = lastUrl.endsWith('/live');
  const isLive  = location.href.endsWith('/live');
  lastUrl = location.href;
  if (isLive && !wasLive) {
    log('info', 'live_search_activated', {});
  } else if (!isLive && wasLive) {
    wsExpectingNewRows = false;
    log('info', 'live_search_deactivated', {});
  }
}).observe(document, { subtree: true, childList: true });

// Also log if page loaded directly on /live URL
if (location.href.endsWith('/live')) {
  log('info', 'live_search_activated', { via: 'direct_url' });
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

function handleNewResultset(node) {
  const row = node.querySelector?.('.row[data-id]');
  if (!row) return;

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

  const lastAction = { name, price: priceStr, ts: Date.now() };
  saveState({ last_action: lastAction });
  updateOverlayLastAction(lastAction);
  log('info', 'clicked', { name, price: priceStr });
}

// ─── MutationObserver ────────────────────────────────────────────────────────

let resultsObserver = null;

function attachResultsObserver(resultsEl) {
  if (resultsObserver) return;
  resultsObserver = new MutationObserver((mutations) => {
    let clickedThisBatch = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1 || !node.classList?.contains('resultset')) continue;
        const row = node.querySelector('.row[data-id]');
        const id  = row?.getAttribute('data-id');
        if (!id || seen.has(id)) continue;

        if (!clickedThisBatch && wsExpectingNewRows && enabled && !emergency) {
          wsExpectingNewRows = false; // consume the flag
          handleNewResultset(node);
          clickedThisBatch = true;
        } else {
          seen.add(id);
          log('debug', 'batch_extra_skipped', { id: id.slice(0, 12) });
        }
      }
    }
  });
  resultsObserver.observe(resultsEl, { childList: true });
  log('info', 'observer_attached', {});
}

function watchForResults() {
  const existing = document.querySelector('.results');
  if (existing) {
    attachResultsObserver(existing);
    return;
  }
  log('info', 'waiting_for_results', {});
  const bodyObserver = new MutationObserver(() => {
    const el = document.querySelector('.results');
    if (el) {
      bodyObserver.disconnect();
      attachResultsObserver(el);
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
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
      padding: 5px 10px;
      font-size: 11px;
      color: #7a6a50;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
      border: none;
      transition: background 0.15s;
    }
    #poe-sniper-btn.stop   { background: #8b1a1a; border: 1px solid #c0392b; color: #ffcdd2; }
    #poe-sniper-btn.stop:hover { background: #c0392b; }
    #poe-sniper-btn.start  { background: #1a3a1a; border: 1px solid #2d6a2d; color: #a0d0a0; }
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

  // Restore position
  chrome.storage.local.get('overlay_pos', ({ overlay_pos }) => {
    if (overlay_pos?.left) {
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
      el.style.left   = overlay_pos.left;
      el.style.top    = overlay_pos.top;
    }
  });

  // Button click
  el.querySelector('#poe-sniper-btn').addEventListener('click', () => {
    if (enabled && !emergency) {
      triggerEmergencyStop('overlay_button');
    } else {
      // Resume
      emergency = false;
      enabled   = true;
      saveState({ enabled: true, emergency: false, emergency_reason: null });
      log('info', 'resumed', { via: 'overlay_button' });
      updateOverlay();
    }
  });

  updateOverlay();
}

function updateOverlay() {
  if (!overlayEl) return;

  const dot = overlayEl.querySelector('#poe-sniper-dot');
  const btn = overlayEl.querySelector('#poe-sniper-btn');

  // Dot color
  if (emergency) {
    dot.className = 'red';
  } else if (rateLimitUsed >= rateLimitMax - 1) {
    dot.className = 'yellow';
  } else if (enabled) {
    dot.className = '';     // green (default)
  } else {
    dot.className = 'red';
  }

  // Button label + style
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
