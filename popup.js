// PoE Trade Sniper — popup script

'use strict';

const toggleEnabled    = document.getElementById('toggleEnabled');
const statusDot        = document.getElementById('statusDot');
const historyList      = document.getElementById('historyList');
const rateBar          = document.getElementById('rateBar');
const rateText         = document.getElementById('rateText');
const actionBtn        = document.getElementById('actionBtn');
const actionBtnFill    = document.getElementById('actionBtnFill');
const actionBtnText    = document.getElementById('actionBtnText');
const toggleAutoResume = document.getElementById('toggleAutoResume');
const toggleDebug      = document.getElementById('toggleDebug');
const logBox           = document.getElementById('logBox');
const btnExport        = document.getElementById('btnExport');

// ─── Load state ───────────────────────────────────────────────────────────────

chrome.storage.local.get(
  ['enabled', 'debug', 'auto_resume', 'emergency', 'click_history', 'rate_used', 'rate_max', 'sniper_log', 'rate_pause_until', 'rate_pause_started_at'],
  (s) => {
    toggleEnabled.checked    = !!s.enabled;
    toggleAutoResume.checked = s.auto_resume !== false;
    applyActionBtn(!!s.enabled, !!s.emergency, s.rate_pause_until || 0, s.rate_pause_started_at || 0);
    updateDot(!!s.enabled, !!s.emergency);
    applyDebug(!!s.debug);
    renderHistory(s.click_history || []);
    applyRate(s.rate_used || 0, s.rate_max || 6);
    renderLog(s.sniper_log || []);
  }
);

// ─── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes) => {
  if ('enabled' in changes) {
    toggleEnabled.checked = !!changes.enabled.newValue;
  }
  if ('auto_resume' in changes) {
    toggleAutoResume.checked = changes.auto_resume.newValue !== false;
  }

  // Refresh animated button on any state-relevant change
  const actionKeys = ['enabled', 'emergency', 'rate_pause_until', 'rate_pause_started_at'];
  if (actionKeys.some((k) => k in changes)) {
    chrome.storage.local.get(['enabled', 'emergency', 'rate_pause_until', 'rate_pause_started_at'], (s) => {
      applyActionBtn(!!s.enabled, !!s.emergency, s.rate_pause_until || 0, s.rate_pause_started_at || 0);
      updateDot(!!s.enabled, !!s.emergency);
    });
  }

  if ('click_history' in changes) renderHistory(changes.click_history.newValue || []);
  if ('rate_used' in changes || 'rate_max' in changes) {
    chrome.storage.local.get(['rate_used', 'rate_max'], (s) => {
      applyRate(s.rate_used || 0, s.rate_max || 6);
    });
  }
  if ('sniper_log' in changes) renderLog(changes.sniper_log.newValue || []);
});

// ─── Animated action button ───────────────────────────────────────────────────

let waitingTimer = null;

function applyActionBtn(enabled, emergency, ratePauseUntil, ratePauseStartedAt) {
  clearWaitingCountdown();

  const now = Date.now();
  if (!emergency && ratePauseUntil > now) {
    actionBtn.className = 'action-btn waiting';
    startWaitingCountdown(ratePauseUntil, ratePauseStartedAt);
  } else if (enabled && !emergency) {
    actionBtn.className = 'action-btn stop';
    actionBtnText.textContent = '■  STOP';
    actionBtnFill.style.width = '0%';
  } else {
    actionBtn.className = 'action-btn start';
    actionBtnText.textContent = '▶  START';
    actionBtnFill.style.width = '0%';
  }
}

function startWaitingCountdown(until, startedAt) {
  function tick() {
    const now       = Date.now();
    const remaining = until - now;
    if (remaining <= 0) {
      clearWaitingCountdown();
      actionBtnFill.style.width = '0%';
      return;
    }
    const total = Math.max(1, until - startedAt);
    const pct   = Math.min(100, ((total - remaining) / total) * 100);
    actionBtnFill.style.width    = pct + '%';
    actionBtnText.textContent    = `⏳  WAITING ${Math.ceil(remaining / 1000)}s`;
  }
  tick();
  waitingTimer = setInterval(tick, 250);
}

function clearWaitingCountdown() {
  if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateDot(isEnabled, isEmergency) {
  chrome.storage.local.get(['rate_used', 'rate_max'], (s) => {
    const used = s.rate_used || 0;
    const max  = s.rate_max  || 6;
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

function applyDebug(val) {
  toggleDebug.checked = val;
  logBox.classList.toggle('visible', val);
  btnExport.classList.toggle('visible', val);
}

function renderHistory(entries) {
  if (!entries.length) {
    historyList.innerHTML = '<div class="history-empty">No clicks yet</div>';
    return;
  }
  historyList.innerHTML = entries.map((e) => {
    const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="history-entry">
      <span class="h-time">${time}</span>
      <span class="h-name">${e.name}</span>
      <span class="h-price">${e.price}</span>
    </div>`;
  }).join('');
}

function applyRate(used, max) {
  const pct = max > 0 ? (used / max) * 100 : 0;
  rateBar.style.width      = pct + '%';
  rateBar.style.background = pct >= 80 ? '#e53935' : pct >= 60 ? '#fbc02d' : '#c8a84b';
  rateText.textContent     = `${used} / ${max}`;
}

function renderLog(entries) {
  if (!entries.length) return;
  logBox.innerHTML = [...entries].reverse().slice(0, 100).map((e) => {
    const time    = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dataStr = Object.keys(e.data).length ? ' ' + JSON.stringify(e.data) : '';
    return `<div class="log-entry ${e.level}">${time} ${e.event}${dataStr}</div>`;
  }).join('');
}

// ─── Controls ─────────────────────────────────────────────────────────────────

toggleEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggleEnabled.checked, emergency: false });
});

actionBtn.addEventListener('click', () => {
  if (actionBtn.classList.contains('start')) {
    chrome.storage.local.set({ enabled: true, emergency: false });
    toggleEnabled.checked = true;
  } else {
    // stop or waiting → emergency stop (also cancels rate-pause auto-resume)
    chrome.storage.local.set({
      enabled: false,
      emergency: true,
      emergency_reason: 'popup_button',
      emergency_ts: Date.now(),
      rate_pause_until: 0,
    });
    toggleEnabled.checked = false;
  }
});

toggleAutoResume.addEventListener('change', () => {
  chrome.storage.local.set({ auto_resume: toggleAutoResume.checked });
});

toggleDebug.addEventListener('change', () => {
  chrome.storage.local.set({ debug: toggleDebug.checked });
  applyDebug(toggleDebug.checked);
});

btnExport.addEventListener('click', () => {
  chrome.storage.local.get('sniper_log', ({ sniper_log }) => {
    const blob = new Blob([JSON.stringify(sniper_log || [], null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `poe-sniper-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Forward keyboard shortcut from background to content script
chrome.commands?.onCommand?.addListener((cmd) => {
  if (cmd === 'emergency-stop') {
    chrome.storage.local.set({ enabled: false, emergency: true, emergency_reason: 'keyboard', emergency_ts: Date.now(), rate_pause_until: 0 });
  }
});
