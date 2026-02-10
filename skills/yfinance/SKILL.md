---
name: yfinance
description: Query Yahoo Finance for stock quotes, historical prices, company fundamentals, financials, news, and analyst data.
metadata: { "openclaw": { "emoji": "📈", "requires": { "bins": ["curl"] } } }
---

# Yahoo Finance Data (yfinance)

Get stock, ETF, and crypto market data from Yahoo Finance.

## Commands

### Get current stock quote

```bash
{baseDir}/scripts/quote.sh AAPL
```

### Get historical prices (default: 1 month, daily)

```bash
{baseDir}/scripts/history.sh AAPL
{baseDir}/scripts/history.sh TSLA --period 3mo --interval 1wk
```

Periods: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max
Intervals: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo

### Get company info and fundamentals

```bash
{baseDir}/scripts/info.sh MSFT
```

### Get financial statements

```bash
{baseDir}/scripts/financials.sh AAPL --statement income
{baseDir}/scripts/financials.sh AAPL --statement balance
{baseDir}/scripts/financials.sh AAPL --statement cashflow
```

### Get recent news

```bash
{baseDir}/scripts/news.sh NVDA
```

### Get analyst recommendations and price targets

```bash
{baseDir}/scripts/analyst.sh GOOGL
```

### Batch download prices for multiple tickers

```bash
{baseDir}/scripts/download.sh "AAPL,MSFT,GOOGL,AMZN" --period 5d
```
