# Qwen Autonomous Trading Agent

Qwen is the reasoning layer and now connects directly to Perpl for market data, account state and order execution. AgentHub2 is no longer in the Perpl execution path.

## What this repo does

On every cycle the agent loads your editable strategy, reads current Perpl market configuration and authenticated account state directly from Perpl, researches current web information, checks its own trading journal, asks Qwen to form explicit probability-weighted forecasts, decides whether to act, executes through the direct Perpl trading WebSocket, and records the result in the dashboard activity log.

The forecasting workflow is inspired by FutureBench: current information is gathered first, competing hypotheses are weighed, uncertainty is made explicit, and the eventual decision is grounded in time-bound predictions. FutureBench itself is an evaluation benchmark rather than a trading signal source.

## Dashboard

The app serves a browser dashboard where you can edit strategy instructions, enable/disable the loop, run a cycle manually, and inspect activity. Your strategy can be plain English: markets to watch, signals, entries/exits, sizing, leverage, invalidation conditions, and when to stay out.

## Direct Perpl connection

Perpl's current API uses an enrolled Ed25519 API key pair. The opaque `X-API-Key` token and the matching private key are kept server-side in Render. Qwen signs the trading WebSocket authentication frame (`mt:29`) and subsequent order flow itself. Perpl's public market context is read from `/api/v1/pub/context`; the authenticated trading WebSocket provides wallet/account, orders, positions and order execution.

A Perpl API key must already be enrolled. Creating or enrolling keys is separate from trading: Perpl documents that the enrollment origin must be whitelisted, while an already-enrolled key can be used directly by a server-side trading client.

## Setup

Create `.env` from `.env.example` and set:

- `QWEN_API_KEY`
- `QWEN_BASE_URL`
- `QWEN_MODEL`
- `PERPL_API_URL`
- `PERPL_WS_URL`
- `PERPL_CHAIN_ID`
- `PERPL_API_KEY`
- `PERPL_API_PRIVATE_KEY`
- `TAVILY_API_KEY`
- `DASHBOARD_PASSWORD`

Install and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Architecture

```text
                    current web/news
                         |
                         v
Browser --> Qwen dashboard --> Qwen reasoning
                         |       |
                         |       +--> forecast + evidence
                         |       +--> trading memory
                         |       +--> Perpl markets/state
                         v
                 Perpl trading API
                         |
                         v
                       Perpl
```

Keep `PERPL_API_KEY`, `PERPL_API_PRIVATE_KEY`, `QWEN_API_KEY`, and `TAVILY_API_KEY` server-side. Never put them into browser JavaScript or commit them to Git.
