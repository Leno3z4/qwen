import 'dotenv/config';
import OpenAI from 'openai';
import { loadStrategy } from './strategy.js';
import { startDashboard, type AgentStatus } from './server.js';

type Json = Record<string, unknown>;

const baseUrl = (process.env.AGENTHUB_URL ?? 'https://agenthub2-gray.vercel.app').replace(/\/$/, '');
let agentCredential = process.env.AGENT_CREDENTIAL;
const identityAccessKey = process.env.AGENT_IDENTITY_ACCESS_KEY;
const agentName = process.env.AGENT_NAME ?? 'Qwen Autonomous Trader';
if (!agentCredential && !identityAccessKey) throw new Error('Set AGENT_CREDENTIAL or AGENT_IDENTITY_ACCESS_KEY');
if (!process.env.QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');

const qwen = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
});

const tools = [
  { type: 'function' as const, function: { name: 'get_markets', description: 'Get currently available Perpl markets and their configuration.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_state', description: 'Get fresh authenticated Perpl account state including balance, open orders, positions and head block.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: {
    name: 'place_order',
    description: 'Place an authenticated Perpl order through AgentHub2. Use exact market id and Perpl order parameters returned by tools.',
    parameters: { type: 'object', properties: {
      mkt: { type: 'integer' }, t: { type: 'integer' }, s: { type: 'number' }, lv: { type: 'number' }, fl: { type: 'integer' },
      p: { type: 'number' }, a: { type: 'string' }, ms: { type: 'integer' }, tif: { type: 'integer' }, tp: { type: 'number' },
      tpc: { type: 'number' }, tr: { type: 'number' }, lp: { type: 'number' }, bf: { type: 'number' },
    }, required: ['mkt', 't', 's', 'lv', 'fl'], additionalProperties: false },
  } },
  { type: 'function' as const, function: {
    name: 'cancel_order',
    description: 'Cancel an existing Perpl order through AgentHub2.',
    parameters: { type: 'object', properties: { mkt: { type: 'integer' }, oid: { type: 'integer' }, lb: { type: 'integer' } }, required: ['mkt', 'oid', 'lb'], additionalProperties: false },
  } },
];

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  status.logs.unshift(line);
  status.logs = status.logs.slice(0, 60);
}

async function connectAgent(): Promise<void> {
  if (!identityAccessKey) throw new Error('Cannot renew AgentHub2 credential without AGENT_IDENTITY_ACCESS_KEY');
  const response = await fetch(`${baseUrl}/api/agent/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity_access_key: identityAccessKey, agent_name: agentName }),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.connection_token !== 'string') throw new Error(`AgentHub2 connect failed (${response.status}): ${JSON.stringify(data)}`);
  agentCredential = data.connection_token;
  log(`AgentHub2 credential connected; expires ${new Date(Number(data.expires_at)).toISOString()}.`);
}

async function agenthub(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!agentCredential) await connectAgent();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${agentCredential}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (response.status === 401 && identityAccessKey) {
    await connectAgent();
    const retry = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${agentCredential}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const retryText = await retry.text();
    let retryBody: unknown;
    try { retryBody = retryText ? JSON.parse(retryText) : null; } catch { retryBody = retryText; }
    if (!retry.ok) throw new Error(`AgentHub2 ${retry.status}: ${typeof retryBody === 'string' ? retryBody : JSON.stringify(retryBody)}`);
    return retryBody;
  }
  if (!response.ok) throw new Error(`AgentHub2 ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function runTool(name: string, args: Json): Promise<unknown> {
  if (name === 'get_markets') return agenthub('/api/agent/perpl/markets');
  if (name === 'get_state') return agenthub('/api/agent/perpl/state');
  if (name === 'place_order') return agenthub('/api/agent/perpl/order', { method: 'POST', body: JSON.stringify(args) });
  if (name === 'cancel_order') return agenthub('/api/agent/perpl/order/cancel', { method: 'POST', body: JSON.stringify(args) });
  throw new Error(`Unknown tool: ${name}`);
}

const status: AgentStatus = {
  running: false,
  enabled: process.env.AUTONOMOUS_ENABLED !== 'false',
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  logs: [],
};

let activeCycle: Promise<void> | null = null;

export async function cycle() {
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    status.running = true;
    status.lastRunAt = new Date().toISOString();
    status.lastError = null;
    try {
      const strategy = await loadStrategy();
      const system = `You are an autonomous Perpl trading agent operating through AgentHub2.
AgentHub2 is the execution and authorization layer. Never bypass it and never invent exchange/account data.
Before trading, inspect fresh market configuration and account state. Respect actual market parameters and current positions/orders.
You may buy, sell, cancel, or do nothing. Only use exact Perpl order fields supported by the tools.
Do not claim success unless a tool returned success.

USER-PROVIDED STRATEGY:
${strategy}`;
      const messages: any[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Run one autonomous trading cycle. Inspect current markets and account state, apply the user strategy, and take an action only when its rules call for one. Finish with a concise explanation.' },
      ];
      const maxSteps = Number(process.env.MAX_TOOL_STEPS ?? 10);
      for (let step = 0; step < maxSteps; step++) {
        const response = await qwen.chat.completions.create({ model: process.env.QWEN_MODEL ?? 'qwen3-max', messages, tools, tool_choice: 'auto' });
        const message: any = response.choices[0]?.message;
        if (!message) throw new Error('Qwen returned no message');
        messages.push(message);
        if (!message.tool_calls?.length) {
          const result = String(message.content ?? 'No final response.');
          status.lastResult = result;
          log(result);
          return;
        }
        for (const call of message.tool_calls) {
          let result: unknown;
          try { result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}')); }
          catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      throw new Error('Qwen exceeded MAX_TOOL_STEPS');
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      log(`Cycle failed: ${status.lastError}`);
      throw error;
    } finally {
      status.running = false;
    }
  })();
  try { await activeCycle; } finally { activeCycle = null; }
}

async function main() {
  startDashboard(cycle, () => ({ ...status, logs: [...status.logs] }), (enabled) => {
    status.enabled = enabled;
    log(enabled ? 'Autonomous loop enabled from dashboard.' : 'Autonomous loop disabled from dashboard.');
  });

  if (!agentCredential && identityAccessKey) await connectAgent();
  if (status.enabled) await cycle();

  const interval = Number(process.env.TRADING_INTERVAL_MS ?? 300_000);
  if (interval > 0) setInterval(() => {
    if (!status.enabled || status.running) return;
    cycle().catch(() => undefined);
  }, interval);

  if (identityAccessKey) {
    const refreshMs = Number(process.env.AGENT_CREDENTIAL_REFRESH_MS ?? 12 * 60 * 60 * 1000);
    if (refreshMs > 0) setInterval(() => connectAgent().catch((error) => log(`Credential refresh failed: ${error instanceof Error ? error.message : String(error)}`)), refreshMs);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
