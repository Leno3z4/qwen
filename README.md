# Qwen Autonomous Trading Agent

Qwen is the reasoning layer and AgentHub2 is the authenticated execution layer for Perpl.

## What this repo does

On every cycle the agent loads your editable strategy, reads current Perpl market configuration and account state through AgentHub2, researches current web information, checks its own trading journal, asks Qwen to form explicit probability-weighted forecasts, decides whether to act, executes only through AgentHub2, and records the result in the dashboard activity log.

The forecasting workflow is inspired by FutureBench: current information is gathered first, competing hypotheses are weighed, uncertainty is made explicit, and the eventual decision is grounded in time-bound predictions. FutureBench itself is an evaluation benchmark rather than a trading signal source. citeturn459926search0

## Dashboard

The app serves a browser dashboard where you can edit strategy instructions, enable/disable the loop, run a cycle manually, and inspect activity. Your strategy can be plain English: markets to watch, signals, entries/exits, sizing, leverage, invalidation conditions, and when to stay out.

## Live web research

Set `TAVILY_API_KEY` to give the agent a live web-search tool. Qwen can then search for current news, announcements, research, market context, and other information before deciding. The tool returns source titles, URLs, publication dates when available, and extracted snippets.

The agent is instructed to prefer independent corroboration and first-party sources where possible, and not to treat web content or prediction-market opinions as facts.

## Trading memory

Qwen now has a local `data/trading-memory.json` journal. After each cycle it records the cycle result and tool usage. Future cycles can call `get_trading_memory` to review prior decisions and repeated patterns.

This builds historical memory from the point the feature is enabled. AgentHub2's current live account route exposes current positions/orders/account state, but the Qwen journal is what provides persistent cross-cycle context to the reasoning loop.

Because `data/` is git-ignored, persistent deployment storage is recommended when you want the journal and strategy to survive redeploys.

## Setup

Create `.env` from `.env.example` and set:

- `QWEN_API_KEY`
- `QWEN_BASE_URL`
- `QWEN_MODEL`
- `TAVILY_API_KEY`
- `AGENTHUB_URL`
- `AGENT_IDENTITY_ACCESS_KEY` or `AGENT_CREDENTIAL`
- `AGENT_NAME`
- `DASHBOARD_PASSWORD`

Install and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## AgentHub2 connection

AgentHub2 exposes `POST /api/agent/connect`. It accepts an identity access key/connection token and returns a short-lived `connection_token` for the created agent. Its current trading credential lifetime is capped at 24 hours, so the Qwen app refreshes it every 12 hours when `AGENT_IDENTITY_ACCESS_KEY` is configured.

## Architecture

```text
                    current web/news
                         |
                         v
Browser --> Qwen dashboard --> Qwen reasoning
                         |       |
                         |       +--> forecast + evidence
                         |       +--> trading memory
                         |       +--> Perpl state/markets
                         v
                      AgentHub2
                         |
                         v
                        Perpl
```

Keep `AGENT_IDENTITY_ACCESS_KEY`, `AGENT_CREDENTIAL`, `QWEN_API_KEY`, and `TAVILY_API_KEY` server-side. Never put them into browser JavaScript or commit them to Git.
