// PoE Trade Sniper — content script
// Runs on pathofexile.com/trade/* pages

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let enabled = true;
let debugEnabled = false;
let emergency = false;
let rateLimitUsed = 0;
let rateLimitMax = 6;
const seen = new Set();
const LOG = [];

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, event, data = {}) {
  const entry = { ts: Date.now(), level, event, data };
  LOG.push(entry);
  if (LOG.length > 200) LOG.shift();
  if (debugEnabled) {
    chrome.storage.local.set({ sniper_log: LOG });
    console.log(`[PoE Sniper][${level}] ${event}`, data);
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function loadState() {
  chrome.storage.local.get(
    ['enabled', 'debug', 'emergency', 'overlay_pos'],
    (result) => {
      enabled = result.enabled !== false;
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
    updateOverlay();
    log('info', 'enabled_changed', { enabled });
  }
  if ('debug' in changes) {
    debugEnabled = changes.debug.newValue;
  }
  if ('emergency' in changes) {
    emergency = changes.emergency.newValue;
    enabled = !emergency;
    updateOverlay();
    log('warn', 'emergency_changed', { emergency });
  }
  if ('rate_used' in changes) {
    rateLimitUsed = changes.rate_used.newValue || 0;
    updateOverlay();
  }
});

// ─── Emergency stop ───────────────────────────────────────────────────────────

function triggerEmergencyStop(reason) {
  emergency = true;
  enabled = false;
  saveState({ enabled: false, emergency: true, emergency_reason: reason, emergency_ts: Date.now() });
  updateOverlay();
  log('error', 'emergency_stop', { reason });
  console.error(`[PoE Sniper] Emergency stop triggered: ${reason}`);
}

function warnRateLimit(used) {
  rateLimitUsed = used;
  saveState({ rate_used: used, rate_max: rateLimitMax });
  updateOverlay();
  log('warn', 'rate_limit_warning', { used, max: rateLimitMax });
}

// ─── Keyboard shortcut ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'emergency-stop') triggerEmergencyStop('keyboard_shortcut');
});

// ─── XHR interception (rate limit monitoring) ────────────────────────────────

(function interceptXHR() {
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._sniper_url = url;
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if (!this._sniper_url?.includes('/api/trade/fetch/')) return;

      if (this.status === 429 || this.status === 403) {
        triggerEmergencyStop('http_' + this.status);
        return;
      }

      const state = this.getResponseHeader('X-Rate-Limit-Account-State');
      const limitHeader = this.getResponseHeader('X-Rate-Limit-Account');
      if (limitHeader) {
        // format: "6:4:10" → max=6
        rateLimitMax = parseInt(limitHeader.split(':')[0], 10) || 6;
      }
      if (state) {
        const parts = state.split(':').map(Number);
        const used = parts[0];
        const banTime = parts[2];
        rateLimitUsed = used;
        saveState({ rate_used: used, rate_max: rateLimitMax });
        updateOverlay();
        if (banTime > 0) {
          triggerEmergencyStop('rate_limit_ban');
        } else if (used >= rateLimitMax - 1) {
          warnRateLimit(used);
        }
        log('debug', 'rate_state', { state, used, banTime });
      }
    });
    return _send.call(this, ...args);
  };
})();

// ─── Sound alert ─────────────────────────────────────────────────────────────

function playAlert() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
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

  log('debug', 'new_row_seen', { id });

  if (!enabled || emergency) {
    log('debug', 'skipped_disabled', { id, enabled, emergency });
    return;
  }

  if (seen.has(id)) {
    log('debug', 'skipped_dupe', { id });
    return;
  }

  seen.add(id);

  const btn = row.querySelector('.btns .direct-btn');
  if (!btn) {
    log('warn', 'btn_not_found', { id });
    return;
  }

  // Extract price for logging/overlay
  const priceEl = row.querySelector('[data-field="price"] span:not(.price-label)');
  const currencyEl = row.querySelector('.currency-text');
  const price = priceEl?.textContent?.trim();
  const currency = currencyEl?.querySelector('span')?.textContent?.trim() || '';
  const name = row.querySelector('.itemName .lc')?.textContent?.trim() || id.slice(0, 8);
  const priceStr = price ? `${price} ${currency}`.trim() : '?';

  playAlert();
  btn.click();

  const lastAction = { name, price: priceStr, ts: Date.now() };
  saveState({ last_action: lastAction });
  updateOverlayLastAction(lastAction);
  log('info', 'clicked', { id, name, price: priceStr });
}

// ─── MutationObserver ────────────────────────────────────────────────────────

let resultsObserver = null;

function attachResultsObserver(resultsEl) {
  if (resultsObserver) return;
  resultsObserver = new MutationObserver((mutations) => {
    // Collect all new .resultset nodes, handle only the first new unique one
    let clicked = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('resultset')) {
          const row = node.querySelector('.row[data-id]');
          const id = row?.getAttribute('data-id');
          // Mark all seen immediately to prevent double-click on batch
          if (id && !seen.has(id)) {
            if (!clicked && enabled && !emergency) {
              handleNewResultset(node);
              clicked = true; // only first in batch triggers click
            } else {
              seen.add(id);
              log('debug', 'batch_skipped', { id });
            }
          }
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
  // .results doesn't exist yet — wait for it
  const bodyObserver = new MutationObserver(() => {
    const el = document.querySelector('.results');
    if (el) {
      bodyObserver.disconnect();
      attachResultsObserver(el);
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  log('info', 'waiting_for_results', {});
}

// ─── In-page overlay ─────────────────────────────────────────────────────────

let overlayEl = null;

function createOverlay() {
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
      <div id="poe-sniper-rate-bar-bg">
        <div id="poe-sniper-rate-bar"></div>
      </div>
    </div>
    <button id="poe-sniper-stop">■ STOP</button>
  `;

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
      font-family: 'Fontin SmallCaps', sans-serif;
      font-size: 13px;
      color: #d0c4a0;
      padding: 0;
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
    #poe-sniper-title { font-weight: bold; color: #c8a84b; letter-spacing: 0.5px; }
    #poe-sniper-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #4caf50;
      box-shadow: 0 0 6px #4caf50;
      flex-shrink: 0;
    }
    #poe-sniper-dot.red { background: #e53935; box-shadow: 0 0 6px #e53935; }
    #poe-sniper-dot.yellow { background: #fbc02d; box-shadow: 0 0 6px #fbc02d; }
    #poe-sniper-last {
      padding: 6px 10px;
      font-size: 12px;
      color: #a09070;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #poe-sniper-rate-wrap { padding: 2px 10px 6px; }
    #poe-sniper-rate-label { font-size: 11px; color: #8a7a60; margin-bottom: 3px; }
    #poe-sniper-rate-bar-bg {
      height: 4px; background: #333; border-radius: 2px; overflow: hidden;
    }
    #poe-sniper-rate-bar {
      height: 100%; width: 0%; background: #c8a84b;
      border-radius: 2px; transition: width 0.3s, background 0.3s;
    }
    #poe-sniper-stop {
      display: block;
      width: calc(100% - 16px);
      margin: 0 8px 8px;
      padding: 6px;
      background: #8b1a1a;
      border: 1px solid #c0392b;
      border-radius: 4px;
      color: #ffcdd2;
      font-size: 12px;
      font-weight: bold;
      letter-spacing: 1px;
      cursor: pointer;
    }
    #poe-sniper-stop:hover { background: #c0392b; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(el);

  // Dragging
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
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = (e.clientX - ox) + 'px';
    el.style.top = (e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    const pos = { left: el.style.left, top: el.style.top, right: el.style.right, bottom: el.style.bottom };
    saveState({ overlay_pos: pos });
  });

  // Restore position
  chrome.storage.local.get('overlay_pos', ({ overlay_pos }) => {
    if (overlay_pos?.left) {
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = overlay_pos.left;
      el.style.top = overlay_pos.top;
    }
  });

  // Stop button
  el.querySelector('#poe-sniper-stop').addEventListener('click', () => {
    triggerEmergencyStop('overlay_button');
  });

  overlayEl = el;
  updateOverlay();
}

function updateOverlay() {
  if (!overlayEl) return;
  const dot = overlayEl.querySelector('#poe-sniper-dot');
  if (emergency) {
    dot.className = 'red';
  } else if (rateLimitUsed >= rateLimitMax - 1) {
    dot.className = 'yellow';
  } else if (enabled) {
    dot.className = '';
  } else {
    dot.className = 'red';
  }
  updateOverlayRate();
}

function updateOverlayRate() {
  if (!overlayEl) return;
  const pct = rateLimitMax > 0 ? (rateLimitUsed / rateLimitMax) * 100 : 0;
  const bar = overlayEl.querySelector('#poe-sniper-rate-bar');
  const text = overlayEl.querySelector('#poe-sniper-rate-text');
  bar.style.width = pct + '%';
  bar.style.background = pct >= 80 ? '#e53935' : pct >= 60 ? '#fbc02d' : '#c8a84b';
  text.textContent = `${rateLimitUsed}/${rateLimitMax}`;
}

function updateOverlayLastAction(action) {
  if (!overlayEl) return;
  const el = overlayEl.querySelector('#poe-sniper-last');
  const time = new Date(action.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent = `${action.name} ${action.price} ${time}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState();
createOverlay();
watchForResults();
