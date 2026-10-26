# Changelog

All notable changes to Stonks Watch are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-10-26

First public release.

### Added

- **Status bar profit/loss.** One item with your total profit or loss since purchase, as a percentage: `Stocks +4.21% | Crypto -1.30%` when you hold both. The tooltip has the details, and notes which markets are closed.
- **Pinned tickers.** Pin any holding, index or coin to the status bar (`AAPL $231.40 +0.67%`) with **Pin Ticker to Status Bar**, and remove it with **Unpin Ticker from Status Bar**.
- **Portfolio panel.** A Stocks | Crypto switcher where each view has its own totals, holdings table and Markets table (the NIFTY 50, SENSEX, NIFTY BANK, S&P 500, Dow Jones and Nasdaq Composite indices for Stocks; BTC, ETH, SOL, BNB and XRP for Crypto), plus an INR | USD toggle.
- **Value chart.** A 1D, 15D and 30D chart of your portfolio value, drawn from the holdings you had on each day.
- **Heatmap view.** TradingView market heatmaps for the S&P 500, Nasdaq 100, Dow 30, SENSEX and crypto coins. They load only while the view is shown and need network access.
- **Holdings.** Add, edit and remove holdings on the NSE, the BSE, US markets and crypto, with a quantity, a buy price and an optional buy date. Totals are shown in INR or USD, converted with the live USDINR rate.
- **Data sources.** Yahoo Finance by default. An optional free Finnhub API key (kept in the editor's secret storage) is used first for US and crypto quotes, with Yahoo as the fallback.
- **Hide amounts mode.** Shows percentages only, with no quantities, prices or amounts.
- **Settings.** `stonks.baseCurrency` (INR or USD), `stonks.refreshIntervalSeconds` (default 60, minimum 15) and `stonks.hideAmounts`.
- **Commands.** Open Portfolio, Add Holding, Edit Holding, Remove Holding, Toggle Hide Amounts, Set Base Currency, Set Refresh Interval, Pin Ticker to Status Bar, Unpin Ticker from Status Bar, Refresh, Set Finnhub API Key and Clear Finnhub API Key, all under the **Stonks** category.
- **Works in Cursor** as well as VS Code.

### Performance

- **Closed markets are not refreshed.** NSE and BSE quotes stop outside 09:15 to 15:30 IST, and US quotes outside 09:30 to 16:00 Eastern time (daylight saving included). One last fetch after the close captures the final price, and the last close stays on screen. Crypto refreshes around the clock; currency rates at most every 15 minutes. Holidays are not modelled, so an exchange holiday is treated as an open day.
- **Fewer requests in the background.** A window that is not focused refreshes 5 times less often, and refreshes at once when you come back to it if its data is stale. If nothing needs fetching there are no timers running, only a single wake-up at the next market open.
- **One fetch for all windows.** Editor windows share one quote cache, so a quote fetched by one window is reused by the others.
- **Fast start.** The status bar shows the last known numbers right after the editor starts, before any network request.
- **Politeness.** Duplicate symbols are fetched once, requests run a few at a time, and the extension backs off after an HTTP 429 (too many requests) reply.
- **No wasted work.** The status bar and the panel are updated only when something changed.
