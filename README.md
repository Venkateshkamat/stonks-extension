# Stonks

Watch your stock and crypto holdings from VS Code or Cursor.

- Status bar item with your total profit/loss % since purchase.
- Add holdings (NSE, BSE, US, crypto) with quantity, buy price and optional buy date.
- Optional free [Finnhub](https://finnhub.io/register) API key for US and crypto quotes; Yahoo Finance is used otherwise (and always for NSE/BSE, history, indices and FX).
- Hide amounts mode shows percentages only.

## Commands

All commands are in the command palette under **Stonks**: Open Portfolio, Add Holding, Edit Holding, Remove Holding, Toggle Hide Amounts, Refresh, Set/Clear Finnhub API Key.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `stonks.baseCurrency` | `INR` | Currency for portfolio totals (`INR` or `USD`). |
| `stonks.refreshIntervalSeconds` | `60` | Refresh interval, minimum 15. |
| `stonks.hideAmounts` | `false` | Show percentages only. |

## Development

```
npm install
npm run compile   # typecheck + bundle to dist/
npm test          # unit tests (plain node, no VS Code needed)
```

Press F5 in VS Code/Cursor to launch an Extension Development Host.

Market data is provided by Finnhub and Yahoo Finance and may be delayed or inaccurate. This extension is not financial advice.
