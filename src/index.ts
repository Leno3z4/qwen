import 'dotenv/config';
import OpenAI from 'openai';
import { loadStrategy } from './strategy.js';
import { loadTradingMemory, saveTradingMemory, webResearch } from './research.js';
import { startDashboard, type AgentStatus } from './server.js';

type Json = Record<string, unknown>;

const baseUrl = (process.env.AGENTHUB_URL ?? 'https://agenthub2-gray.vercel.app').replace(/\/$/, '');
const agentAccessKey = process.env.AGENTHUB_ACCESS_KEY;
let connectionToken: string | null = null;
let connectionExpiresAt = 0;
const agentName = process.env.AGENT_NAME ?? 'Qwen Autonomous Trader';
if (!agentAccessKey) throw new Error('Missing AGENTHUB_ACCESS_KEY');
if (!process.env.QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');

const qwen = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: process.env.QWEN_BASE_URL ?? 'https://openrouter.ai/api/v1',
});

const tools = [
  { type: 'function' as const, function: { name: 'get_markets', description: 'Get currently available Perpl markets and their configuration.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_state', description: 'Get fresh authenticated Perpl account state including balance, open orders, positions and head block.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_trading_memory', description: 'Read the agent journal from previous cycles. Use it to learn from prior decisions, research summaries and execution outcomes.', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'web_research', description: 'Search the live web for recent news and analysis relevant to a trading hypothesis. Prefer several independent sources and use this before making a market-moving decision.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'place_order', description: 'Place an authenticated Perpl order through AgentHub2. Use exact market id and Perpl order parameters returned by tools.', parameters: { type: 'object', properties: { mkt: { type: 'integer' }, t: { type: 'integer' }, s: { type: 'number' }, lv: { type: 'number' }, fl: { type: 'integer' }, p: { type: 'number' }, a: { type: 'string' }, ms: { type: 'integer' }, tif: { type: 'integer' }, tp: { type: 'number' }, tpc: { type: 'number' }, tr: { type: 'number' }, lp: { type: 'number' }, bf: { type: 'number' } }, required: ['mkt', 't', 's', 'lv', 'fl'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'cancel_order', description: 'Cancel an existing Perpl order through AgentHub2.', parameters: { type: 'object', properties: { mkt: { type: 'integer' }, oid: { type: 'integer' }, lb: { type: 'integer' } }, required: ['mkt', 'oid', 'lb'], additionalProperties: false } } },
];

const status: AgentStatus = { running: false, enabled: process.env.AUTONOMOUS_ENABLED === 'true', lastRunAt: null, lastResult: null, lastError: null, logs: [] };

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  status.logs.unshift(line);
  status.logs = status.logs.slice(0, 80);
}

async function connectAgent(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/agent/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity_access_key: agentAccessKey, agent_name: agentName, connector: 'perpl' }),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.connection_token !== 'string') {
    throw new Error(`AgentHub2 connect failed (${response.status}): ${JSON.stringify(data)}`);
  }
  connectionToken = data.connection_token;
  connectionExpiresAt = Number(data.expires_at ?? 0);
  log(`AgentHub2 connection token refreshed; expires ${connectionExpiresAt ? new Date(connectionExpiresAt).toISOString() : 'unknown'}.`);
}

async function ensureConnectionToken(): Promise<void> {
  const refreshSkewMs = 60_000;
  if (!connectionToken || (connectionExpiresAt > 0 && Date.now() + refreshSkewMs >= connectionExpiresAt)) {
    await connectAgent();
  }
}

async function agenthub(path: string, init: RequestInit = {}): Promise<unknown> {
  await ensureConnectionToken();
  const request = async () => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${connectionToken}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  let response = await request();
  if (response.status === 401) {
    await connectAgent();
    response = await request();
  }
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`AgentHub2 ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function runTool(name: string, args: Json): Promise<unknown> {
  if (name === 'get_markets') return agenthub('/api/agent/perpl/markets');
  if (name === 'get_state') return agenthub('/api/agent/perpl/state');
  if (name === 'get_trading_memory') return loadTradingMemory(Number(args.limit ?? 20));
  if (name === 'web_research') return webResearch(String(args.query ?? ''), Number(args.max_results ?? 6));
  if (name === 'place_order') return agenthub('/api/agent/perpl/order', { method: 'POST', body: JSON.stringify(args) });
  if (name === 'cancel_order') return agenthub('/api/agent/perpl/order/cancel', { method: 'POST', body: JSON.stringify(args) });
  throw new Error(`Unknown tool: ${name}`);
}

let activeCycle: Promise<void> | null = null;

export async function cycle() {
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    status.running = true;
    status.lastRunAt = new Date().toISOString();
    status.lastError = null;
    const toolNames: string[] = [];
    try {
      const strategy = await loadStrategy();
      const memory = await loadTradingMemory(20);
      const system = `You are an autonomous Perpl trading agent operating through AgentHub2.
AgentHub2 is the execution and authorization layer. Never bypass it and never invent exchange/account data.
Use the user strategy as the governing instruction set.
Use a forecasting-first workflow inspired by FutureBench: gather current evidence from the web, form explicit probability-weighted hypotheses with a time horizon, identify disconfirming evidence, then decide whether the evidence justifies an action.
Do not treat web articles, prediction markets, or model opinions as facts. Prefer primary/first-party sources when possible and seek independent corroboration.
Before trading, inspect fresh market configuration and account state. Use prior journal entries to identify repeated mistakes or successful patterns, but do not blindly copy prior actions.
You may buy, sell, cancel, or do nothing. Only use exact Perpl order fields supported by the tools.
Do not claim success unless a tool returned success.

USER-PROVIDED STRATEGY:\n${strategy}\n\nRECENT TRADING MEMORY:\n${JSON.stringify(memory)}`;
      const messages: any[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Run one autonomous trading cycle. Research what matters, inspect markets/account state, form explicit forecasts, compare against prior experience, then take an action only when the strategy and evidence support it. Finish with a concise explanation including the key forecast and confidence.' },
      ];
      const maxSteps = Number(process.env.MAX_TOOL_STEPS ?? 10);
      let finalResult = 'No final response.';
      for (let step = 0; step < maxSteps; step++) {
        const response = await qwen.chat.completions.create({ model: process.env.QWEN_MODEL ?? 'qwen/qwen3-235b-a22b-2507:free', messages, tools, tool_choice: 'auto' });
        const message: any = response.choices[0]?.message;
        if (!message) throw new Error('Qwen returned no message');
        messages.push(message);
        if (!message.tool_calls?.length) { finalResult = String(message.content ?? finalResult); break; }
        for (const call of message.tool_calls) {
          toolNames.push(call.function.name);
          let result: unknown;
          try { result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}')); }
          catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (step === maxSteps - 1) throw new Error('Qwen exceeded MAX_TOOL_STEPS');
      }
      status.lastResult = finalResult;
      log(finalResult);
      await saveTradingMemory({ timestamp: new Date().toISOString(), action: toolNames.some((name) => name === 'place_order') ? 'trade' : 'no-trade-or-management', toolCalls: toolNames.slice(-30), summary: finalResult.slice(0, 6000) });
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      log(`Cycle failed: ${status.lastError}`);
      await saveTradingMemory({ timestamp: new Date().toISOString(), action: 'error', toolCalls: toolNames.slice(-30), summary: status.lastError });
      throw error;
    } finally {
      status.running = false;
    }
  })();
  try { await activeCycle; } finally { activeCycle = null; }
}

async function main() {
  startDashboard(cycle, () => ({ ...status, logs: [...status.logs] }), (enabled) => { status.enabled = enabled; log(enabled ? 'Autonomous loop enabled from dashboard.' : 'Autonomous loop disabled from dashboard.'); });
  await connectAgent();
  if (status.enabled) await cycle();
  const interval = Number(process.env.TRADING_INTERVAL_MS ?? 300_000);
  if (interval > 0) setInterval(() => { if (!status.enabled || status.running) return; cycle().catch(() => undefined); }, interval);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
