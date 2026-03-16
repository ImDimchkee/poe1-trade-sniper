// PoE Trade Sniper — injected.js
// Runs in MAIN world (document_start) so it can intercept the page's
// actual WebSocket and XMLHttpRequest instances.
// Communicates to content.js (isolated world) via CustomEvents on window.

'use strict';

// ─── WebSocket interception ───────────────────────────────────────────────────
// The live search WS delivers short-lived JWT tokens for new items.
// We fire an event so content.js knows a real WS update just arrived.

(function interceptWebSocket() {
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols != null ? new OrigWS(url, protocols) : new OrigWS(url);

    if (typeof url === 'string' && url.includes('/api/trade/live/')) {
      ws.addEventListener('open', () => {
        window.dispatchEvent(new CustomEvent('poe-sniper-ws', {
          detail: { type: 'open', url }
        }));
      });

      ws.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data.new) && data.new.length > 0) {
            window.dispatchEvent(new CustomEvent('poe-sniper-ws', {
              detail: { type: 'new_items', count: data.new.length }
            }));
          }
        } catch (_) {}
      });

      ws.addEventListener('close', () => {
        window.dispatchEvent(new CustomEvent('poe-sniper-ws', {
          detail: { type: 'close' }
        }));
      });
    }

    return ws;
  };
  // Copy static properties (OPEN, CLOSED, etc.)
  Object.assign(window.WebSocket, OrigWS);
  window.WebSocket.prototype = OrigWS.prototype;
})();

// ─── XHR interception ────────────────────────────────────────────────────────
// Reads X-Rate-Limit-Account-State from /api/trade/fetch/ responses.

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

      const status = this.status;
      const accountState = this.getResponseHeader('X-Rate-Limit-Account-State');
      const accountLimit = this.getResponseHeader('X-Rate-Limit-Account');

      window.dispatchEvent(new CustomEvent('poe-sniper-rate', {
        detail: { status, accountState, accountLimit }
      }));
    });
    return _send.call(this, ...args);
  };
})();
