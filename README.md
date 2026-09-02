# Qwen Autonomous Trading Agent

Qwen is the reasoning layer and AgentHub2 is the authenticated execution layer for Perpl.

## What this repo does

On every cycle the agent loads your editable strategy, reads current Perpl market configuration and account state through AgentHub2, lets Qwen decide whether to act, executes only through AgentHub2, and records the result in the dashboard activity log.

The app also serves a browser dashboard where you can edit the strategy, enable/disable the loop, run one cycle manually, and inspect recent activity.

## Setup

Create `.env` from `.env.example` and set `QWEN_API_KEY`, `QWEN_BASE_URL`, `QWEN_MODEL`, `AGENTHUB_URL`, `AGENT_CREDENTIAL`, and `DASHBOARD_PASSWORD`.

Install and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## AgentHub2 connection

AgentHub2 exposes `POST /api/agent/connect`. It accepts an identity access key/connection token and returns a short-lived `connection_token` for the created agent. Its current credential lifetime is capped at 24 hours, so a true always-on deployment needs credential renewal or periodic re-connection.

Put the resulting connection token in `AGENT_CREDENTIAL`. The current AgentHub2 routes are the source of truth for permissions; the execution layer handles authentication and Perpl order submission.

## Strategy dashboard

The dashboard saves your plain-language trading instructions to `data/strategy.md` and injects them into Qwen's context on every cycle. You can write rules for markets, signals, entries, exits, sizing, leverage, no-trade conditions, and handling of existing positions/orders.

The strategy file is git-ignored runtime state. On an ephemeral host it can be lost after a restart/redeploy, so a persistent disk or another durable store is needed for permanent strategy memory.

## Runtime settings

`TRADING_INTERVAL_MS` controls the loop cadence (default 5 minutes). `MAX_TOOL_STEPS` caps Qwen's tool-calling steps per cycle. `AUTONOMOUS_ENABLED=false` starts with the loop disabled.

`DASHBOARD_PASSWORD` protects the browser dashboard with HTTP Basic Auth. Set it for any public deployment.

## Architecture

```text
Browser dashboard
      |
      v
   Qwen app
      |
      | Qwen tool calls
      v
  AgentHub2
      |
      v
     Perpl
```

Keep `AGENT_CREDENTIAL` and `QWEN_API_KEY` server-side. Never place them in browser JavaScript or commit them to Git.