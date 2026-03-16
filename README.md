# SVITLANA

A Chrome extension that auto-clicks **Travel to Hideout** the moment a new listing appears on the Path of Exile live trade search — faster than any human reaction time.

---

## Features

- **Instant click** — intercepts the live search WebSocket, detects new listings as they hit the DOM, and clicks the button before you can blink
- **"In demand" handling** — auto-confirms the "Teleport anyway?" dialog when GGG raises it
- **Rate limit awareness** — reads `X-Rate-Limit-Account` response headers, shows a live countdown, and auto-resumes live search after the restriction window clears
- **30s cooldown** between clicks with a one-click Skip button in the overlay
- **Three-way sync** — toggling sniping in the popup, the in-page overlay, or the PoE site's own Live Search button all stay in sync
- **Emergency stop** — red STOP button in both popup and overlay, plus keyboard shortcut `Cmd+Shift+X` / `Ctrl+Shift+X`
- **Click history** — last 25 teleports logged with item name, price, and timestamp
- **Debug mode** — structured event log with JSON export

---

## Install

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the `poe-sniper/` folder
5. The SVITLANA icon appears in your toolbar

---

## Usage

1. Open [pathofexile.com/trade](https://www.pathofexile.com/trade) and set your search filters
2. Click the SVITLANA icon → toggle **Sniping ON**
3. Click **Activate Live Search** on the trade page (or toggle sniping — it activates automatically)
4. New listing appears → SVITLANA clicks Travel to Hideout instantly

The in-page overlay (bottom-right corner, draggable) shows the last action, cooldown timer, rate limit bar, and a STOP/START/WAITING button at all times.

---

## Overlay states

| Button | Color | Meaning |
|--------|-------|---------|
| ■ STOP | Red | Sniping active — click to emergency stop |
| ▶ START | Green | Stopped — click to resume |
| ⏳ WAITING | Yellow | Rate limited, auto-resuming — click to cancel |

---

## Dev setup

Auto-reload on file save using [web-ext](https://github.com/mozilla/web-ext):

```bash
npm install -g web-ext
web-ext run --target chromium --source-dir .
```

Or just hit **Refresh** on `chrome://extensions` after each change — the version number in the toolbar confirms the reload.

---

## Version history

| Version | Notes |
|---------|-------|
| 1.2.6 | Renamed to SVITLANA |
| 1.2.5 | Overlay ⏳ WAITING state during rate pause |
| 1.2.4 | Animated action button, auto-resume toggle, skip cooldown, separate rate/cooldown display |
| 1.2.3 | Click confirm button directly if already in-demand |
| 1.2.2 | Watch `.resultset` scope + attribute changes for confirm dialog |
| 1.1.0 | Auto-confirm "In demand. Teleport anyway?" |
| 1.0.9 | Fix observer self-block on wsExpectingNewRows |
| 1.0.0 | Initial release |

---

*SVITLANA is proprietary software. All rights reserved.*
