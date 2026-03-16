// SVITLANA — injected.js
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
        window.dispatchEvent(new CustomEvent('svitlana-ws', {
          detail: { type: 'open', url }
        }));
      });

      ws.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          // GGG live search format: {"result":"<JWT>","count":N}
          if (data.result && data.count > 0) {
            window.dispatchEvent(new CustomEvent('svitlana-ws', {
              detail: { type: 'new_items', count: data.count }
            }));
          }
        } catch (_) {}
      });

      ws.addEventListener('close', () => {
        window.dispatchEvent(new CustomEvent('svitlana-ws', {
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

// ─── Shared rate-event dispatcher ────────────────────────────────────────────

function dispatchRateEvent(url, status, headers) {
  if (!url?.includes('/api/trade/')) return;
  const accountState = headers('X-Rate-Limit-Account-State');
  const accountLimit = headers('X-Rate-Limit-Account');
  window.dispatchEvent(new CustomEvent('svitlana-rate', {
    detail: { status, accountState, accountLimit }
  }));
}

// ─── XHR interception ────────────────────────────────────────────────────────

(function interceptXHR() {
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._sniper_url = typeof url === 'string' ? url : String(url);
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      dispatchRateEvent(
        this._sniper_url,
        this.status,
        (name) => this.getResponseHeader(name)
      );
    });
    return _send.call(this, ...args);
  };
})();

// ─── fetch() interception ─────────────────────────────────────────────────────
// The trade page uses fetch() for /api/trade/fetch/ — XHR alone misses it.

(function interceptFetch() {
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    return _fetch.call(this, input, init).then((response) => {
      dispatchRateEvent(
        url,
        response.status,
        (name) => response.headers.get(name)
      );
      if (url.includes('/api/trade/whisper')) {
        response.clone().json().then((data) => {
          window.dispatchEvent(new CustomEvent('svitlana-whisper', {
            detail: { success: !!data.success }
          }));
        }).catch(() => {});
      }
      return response;
    });
  };
})();
