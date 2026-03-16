// PoE Trade Sniper — popup script

'use strict';

const toggleEnabled = document.getElementById('toggleEnabled');
const statusDot = document.getElementById('statusDot');
const lastActionEl = document.getElementById('lastAction');
const rateBar = document.getElementById('rateBar');
const rateText = document.getElementById('rateText');
const btnStop = document.getElementById('btnStop');
const btnResume = document.getElementById('btnResume');
const emergencyMsg = document.getElementById('emergencyMsg');
const toggleDebug = document.getElementById('toggleDebug');
const logBox = document.getElementById('logBox');
const btnExport = document.getElementById('btnExport');

// ─── Load state ───────────────────────────────────────────────────────────────

chrome.storage.local.get(
  ['enabled', 'debug', 'emergency', 'emergency_reason', 'emergency_ts', 'last_action', 'rate_used', 'rate_max', 'sniper_log'],
  (state) => {
    applyEnabled(state.enabled !== false);
    applyEmergency(!!state.emergency, state.emergency_reason, state.emergency_ts);
    applyDebug(!!state.debug);
    applyLastAction(state.last_action);
    applyRate(state.rate_used || 0, state.rate_max || 6);
    renderLog(state.sniper_log || []);
  }
);

// ─── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes) => {
  if ('enabled' in changes) applyEnabled(changes.enabled.newValue);
  if ('emergency' in changes) {
    chrome.storage.local.get(['emergency_reason', 'emergency_ts'], (s) => {
      applyEmergency(changes.emergency.newValue, s.emergency_reason, s.emergency_ts);
    });
  }
  if ('last_action' in changes) applyLastAction(changes.last_action.newValue);
  if ('rate_used' in changes || 'rate_max' in changes) {
    chrome.storage.local.get(['rate_used', 'rate_max'], (s) => {
      applyRate(s.rate_used || 0, s.rate_max || 6);
    });
  }
  if ('sniper_log' in changes) renderLog(changes.sniper_log.newValue || []);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyEnabled(val) {
  toggleEnabled.checked = val;
  updateDot(val, false);
}

function applyEmergency(val, reason, ts) {
  if (val) {
    btnStop.disabled = true;
    btnResume.style.display = 'block';
    const time = ts ? new Date(ts).toLocaleTimeString() : '';
    const reasonStr = reason ? ` (${reason})` : '';
    emergencyMsg.textContent = `Stopped${reasonStr} at ${time}`;
    emergencyMsg.style.display = 'block';
    updateDot(false, true);
  } else {
    btnStop.disabled = false;
    btnResume.style.display = 'none';
    emergencyMsg.style.display = 'none';
  }
}

function applyDebug(val) {
  toggleDebug.checked = val;
  logBox.classList.toggle('visible', val);
  btnExport.classList.toggle('visible', val);
}

function applyLastAction(action) {
  if (!action) return;
  const time = new Date(action.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  lastActionEl.textContent = `${action.name}  ${action.price}  —  ${time}`;
  lastActionEl.classList.remove('empty');
}

function applyRate(used, max) {
  const pct = max > 0 ? (used / max) * 100 : 0;
  rateBar.style.width = pct + '%';
  rateBar.style.background = pct >= 80 ? '#e53935' : pct >= 60 ? '#fbc02d' : '#c8a84b';
  rateText.textContent = `${used} / ${max}`;
  updateDot(toggleEnabled.checked, false);
}

function updateDot(isEnabled, isEmergency) {
  chrome.storage.local.get(['rate_used', 'rate_max'], (s) => {
    const used = s.rate_used || 0;
    const max = s.rate_max || 6;
    if (isEmergency) {
      statusDot.className = 'status-dot red';
    } else if (used >= max - 1) {
      statusDot.className = 'status-dot yellow';
    } else if (isEnabled) {
      statusDot.className = 'status-dot';
    } else {
      statusDot.className = 'status-dot red';
    }
  });
}

function renderLog(entries) {
  if (!entries.length) return;
  logBox.innerHTML = [...entries].reverse().slice(0, 100).map((e) => {
    const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dataStr = Object.keys(e.data).length ? ' ' + JSON.stringify(e.data) : '';
    return `<div class="log-entry ${e.level}">${time} ${e.event}${dataStr}</div>`;
  }).join('');
}

// ─── Controls ─────────────────────────────────────────────────────────────────

toggleEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggleEnabled.checked, emergency: false });
});

btnStop.addEventListener('click', () => {
  chrome.storage.local.set({ enabled: false, emergency: true, emergency_reason: 'popup_button', emergency_ts: Date.now() });
});

btnResume.addEventListener('click', () => {
  chrome.storage.local.set({ enabled: true, emergency: false, emergency_reason: null });
  toggleEnabled.checked = true;
});

toggleDebug.addEventListener('change', () => {
  chrome.storage.local.set({ debug: toggleDebug.checked });
  applyDebug(toggleDebug.checked);
});

btnExport.addEventListener('click', () => {
  chrome.storage.local.get('sniper_log', ({ sniper_log }) => {
    const blob = new Blob([JSON.stringify(sniper_log || [], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `poe-sniper-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Forward keyboard shortcut from background to content script
chrome.commands?.onCommand?.addListener((cmd) => {
  if (cmd === 'emergency-stop') {
    chrome.storage.local.set({ enabled: false, emergency: true, emergency_reason: 'keyboard', emergency_ts: Date.now() });
  }
});
