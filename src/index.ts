import 'dotenv/config';
import OpenAI from 'openai';

type Json = Record<string, unknown>;

const baseUrl = (process.env.AGENTHUB_URL ?? 'https://agenthub2-gray.vercel.app').replace(/\/$/, '');
const credential = process.env.AGENT_CREDENTIAL;
if (!credential) throw new Error('Missing AGENT_CREDENTIAL');
if (!process.env.QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');

const qwen = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
});

async function agenthub(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`AgentHub2 ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_markets',
      description: 'Get the currently available Perpl markets and their configuration.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_state',
      description: 'Get fresh authenticated Perpl account state including balance, open orders, positions and head block.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'place_order',
      description: 'Place an authenticated Perpl order through AgentHub2. Use the exact market id and Perpl order parameters returned by market/state tools.',
      parameters: {
        type: 'object',
        properties: {
          mkt: { type: 'integer', description: 'Perpl market id' },
          t: { type: 'integer', description: 'Perpl order type' },
          s: { type: 'number', description: 'Order size' },
          lv: { type: 'number', description: 'Leverage' },
          fl: { type: 'integer', description: 'Perpl order flags' },
          p: { type: 'number', description: 'Limit price when required' },
          a: { type: 'string', description: 'Optional auxiliary order field' },
          ms: { type: 'integer', description: 'Market slippage when required' },
          tif: { type: 'integer', description: 'Time-in-force when required' },
          tp: { type: 'number' },
          tpc: { type: 'number' },
          tr: { type: 'number' },
          lp: { type: 'number' },
          bf: { type: 'number' },
        },
        required: ['mkt', 't', 's', 'lv', 'fl'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancel_order',
      description: 'Cancel an existing Perpl order through AgentHub2.',
      parameters: {
        type: 'object',
        properties: {
          mkt: { type: 'integer' },
          oid: { type: 'integer' },
          lb: { type: 'integer', description: 'Fresh Perpl head block / last execution block from state' },
        },
        required: ['mkt', 'oid', 'lb'],
        additionalProperties: false,
      },
    },
  },
];

async function runTool(name: string, args: Json): Promise<unknown> {
  if (name === 'get_markets') return agenthub('/api/agent/perpl/markets');
  if (name === 'get_state') return agenthub('/api/agent/perpl/state');
  if (name === 'place_order') return agenthub('/api/agent/perpl/order', { method: 'POST', body: JSON.stringify(args) });
  if (name === 'cancel_order') return agenthub('/api/agent/perpl/order/cancel', { method: 'POST', body: JSON.stringify(args) });
  throw new Error(`Unknown tool: ${name}`);
}

const system = `You are an autonomous Perpl trading agent operating through AgentHub2.
You have authenticated read and trade tools. AgentHub2 is the execution and authorization layer; never bypass it and never invent exchange/account data.
Before making a trading decision, inspect fresh market configuration and account state. Respect the market's actual parameters and the account's current positions/orders.
You may decide to buy, sell, or do nothing. If you trade, use only the exact Perpl order fields supported by the execution tool.
Do not claim an order succeeded unless the tool returned success. Keep each cycle concise and explain the action taken.`;

async function cycle() {
  const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: 'Run one autonomous trading cycle. Inspect markets and current account state, analyze the available information, and take an action only if your strategy calls for one.' }];
  const maxSteps = Number(process.env.MAX_TOOL_STEPS ?? 10);

  for (let step = 0; step < maxSteps; step++) {
    const response = await qwen.chat.completions.create({
      model: process.env.QWEN_MODEL ?? 'qwen3-max',
      messages,
      tools,
      tool_choice: 'auto',
    });
    const message: any = response.choices[0].message;
    messages.push(message);
    if (!message.tool_calls?.length) {
      console.log(`[${new Date().toISOString()}] ${message.content ?? ''}`);
      return;
    }
    for (const call of message.tool_calls) {
      let result: unknown;
      try {
        result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'));
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('Qwen exceeded MAX_TOOL_STEPS');
}

async function main() {
  await cycle();
  const interval = Number(process.env.TRADING_INTERVAL_MS ?? 300_000);
  if (!(interval > 0)) return;
  setInterval(() => cycle().catch((error) => console.error(`[${new Date().toISOString()}] cycle failed`, error)), interval);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
