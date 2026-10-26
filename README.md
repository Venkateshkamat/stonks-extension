# Stonks Watch

[![VS Marketplace downloads](https://vsmarketplacebadges.dev/downloads-short/venkateshkamat.stonks-watch.svg?label=VS%20Marketplace%20downloads)](https://marketplace.visualstudio.com/items?itemName=venkateshkamat.stonks-watch)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/venkateshkamat/stonks-watch?label=Open%20VSX%20downloads&color=a60ee5)](https://open-vsx.org/extension/venkateshkamat/stonks-watch)
[![Release](https://img.shields.io/github/v/release/Venkateshkamat/stonks-extension?label=release)](https://github.com/Venkateshkamat/stonks-extension/releases/latest)
[![License: MIT](https://img.shields.io/github/license/Venkateshkamat/stonks-extension)](LICENSE)

> Your Indian, US and crypto portfolio in the status bar, one click from a full panel.

![The portfolio panel: totals, holdings with profit and loss, a 30-day chart, index levels and pinned tickers in the status bar](media/screenshot-stocks.png)

## What it does

- Shows your profit/loss in the status bar: `Stocks +4.21% | Crypto -1.30%`.
- Pin any holding, index or coin next to it: `AAPL $231.40 +0.67%`.
- Click it for the panel: **Stocks**, **Crypto** and **Heatmap** views, 1D / 15D / 30D charts, INR / USD totals.
- Supports NSE, BSE, US stocks and crypto. Type the bare symbol (`RELIANCE`, `AAPL`, `BTC`).
- **Hide amounts** shows percentages only, handy for screen sharing.
- Light on CPU and network: closed markets are not refreshed, unfocused windows refresh less, and windows share one cache.
- Works in VS Code and Cursor.

![The Heatmap view showing the S&P 500](media/screenshot-heatmap.png)

## Getting started

Run **Stonks: Add Holding** from the command palette, pick a market, and enter the symbol, quantity and buy price (buy date is optional). Optionally add a free [Finnhub](https://finnhub.io/register) key with **Stonks: Set Finnhub API Key**; without one, Yahoo Finance is used.

All commands are under **Stonks** in the command palette: add, edit or remove holdings, pin or unpin tickers, set base currency, set refresh interval, toggle hide amounts, refresh, and set or clear the Finnhub key.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `stonks.baseCurrency` | `INR` | Currency for portfolio totals: `INR` or `USD`. |
| `stonks.refreshIntervalSeconds` | `60` | Seconds between refreshes (minimum 15). |
| `stonks.hideAmounts` | `false` | Show percentages only. |

## Data and privacy

- Quotes, charts and indices come from Yahoo Finance; US and crypto quotes use Finnhub when you add a key. Heatmaps are TradingView widgets (S&P 500, Nasdaq 100, Dow 30, SENSEX, crypto) and load only while that view is open.
- Holdings stay in your editor's local extension state; the Finnhub key is kept in the editor's secret storage. No telemetry.

## Known limitations

- Yahoo Finance is an unofficial API; data can be delayed. Not financial advice.
- No exchange holiday calendar, and no NIFTY heatmap (TradingView has none).

## Development

```sh
npm ci
npm run compile
npm test                          # unit tests
npm run test:integration          # VS Code (macOS)
npm run test:integration:cursor   # Cursor (macOS)
npm run vsix
```

## Releasing

Creating a GitHub release publishes to the VS Code Marketplace and Open VSX and attaches the `.vsix`.

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry, run all tests locally, push to `main`.
2. Create a release tagged `vX.Y.Z` (must match `version`). Pre-releases publish nothing.
3. If a store fails, re-run Actions → Publish → "Run workflow" with the tag.

Needs repository secrets `VSCE_PAT` (Marketplace) and `OVSX_PAT` (Open VSX).

## License

MIT, see [LICENSE](LICENSE).

![VS Code 1.85+](https://img.shields.io/badge/VS%20Code-1.85%2B-0078d7)
![Cursor supported](https://img.shields.io/badge/Cursor-supported-000000)
