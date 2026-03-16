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
      if (this._sniper_url?.includes('/api/trade/whisper')) {
        if (this.status !== 200) {
          window.dispatchEvent(new CustomEvent('svitlana-whisper', { detail: { success: false } }));
        } else {
          try {
            const data = JSON.parse(this.responseText);
            window.dispatchEvent(new CustomEvent('svitlana-whisper', { detail: { success: !!data.success } }));
          } catch (_) {}
        }
      }
    });
    return _send.call(this, ...args);
  };
})();

// ─── fetch() interception + item-fetch throttle ──────────────────────────────
// The trade page uses fetch() for /api/trade/fetch/ — XHR alone misses it.
// When a WS message delivers 60 items the page fires 60 simultaneous fetches
// and gets rate-limited. We queue /api/trade/fetch/ requests and process at
// most ITEM_FETCH_CONCURRENCY at a time to stay within GGG's limits.

(function interceptFetch() {
  const _fetch                 = window.fetch;
  const ITEM_FETCH_CONCURRENCY = 4;
  const itemQueue              = [];
  let   itemActive             = 0;

  function drainItemQueue() {
    while (itemActive < ITEM_FETCH_CONCURRENCY && itemQueue.length > 0) {
      const { input, init, resolve, reject } = itemQueue.shift();
      itemActive++;
      execFetch(typeof input === 'string' ? input : (input?.url ?? ''), input, init)
        .then(resolve).catch(reject)
        .finally(() => { itemActive--; drainItemQueue(); });
    }
  }

  function execFetch(url, input, init) {
    return _fetch.call(window, input, init).then((response) => {
      dispatchRateEvent(url, response.status, (name) => response.headers.get(name));
      if (url.includes('/api/trade/whisper')) {
        if (response.status !== 200) {
          window.dispatchEvent(new CustomEvent('svitlana-whisper', { detail: { success: false } }));
        } else {
          response.clone().json().then((data) => {
            window.dispatchEvent(new CustomEvent('svitlana-whisper', { detail: { success: !!data.success } }));
          }).catch(() => {});
        }
      }
      return response;
    });
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (url.includes('/api/trade/fetch/')) {
      return new Promise((resolve, reject) => {
        itemQueue.push({ input, init, resolve, reject });
        drainItemQueue();
      });
    }
    return execFetch(url, input, init);
  };
})();
