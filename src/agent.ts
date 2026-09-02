import 'dotenv/config';
import OpenAI from 'openai';
import { loadStrategy } from './strategy.js';
import { loadTradingMemory, saveTradingMemory, webResearch } from './research.js';
import { startDashboard, type AgentStatus } from './server.js';
import { perpl } from './perpl.js';

type Json = Record<string, unknown>;
type ModelConfig = { provider: string; apiKey: string; baseUrl: string; model: string };

if (!process.env.PERPL_API_KEY) throw new Error('Missing PERPL_API_KEY');
if (!process.env.PERPL_API_PRIVATE_KEY && !process.env.PERPL_API_KEY_SECRET) throw new Error('Missing PERPL_API_PRIVATE_KEY');

const primaryProvider = (process.env.MODEL_PROVIDER ?? 'groq').trim().toLowerCase();
const primaryApiKey = primaryProvider === 'groq' ? process.env.GROQ_API_KEY : process.env.MODEL_API_KEY ?? process.env.QWEN_API_KEY;
const primaryBaseUrl = process.env.MODEL_BASE_URL ?? (primaryProvider === 'groq' ? 'https://api.groq.com/openai/v1' : process.env.QWEN_BASE_URL ?? 'https://openrouter.ai/api/v1');
const primaryModelName = process.env.MODEL_NAME ?? (primaryProvider === 'groq' ? 'openai/gpt-oss-120b' : process.env.QWEN_MODEL ?? 'qwen/qwen3-235b-a22b-2507:free');
if (!primaryApiKey) throw new Error(primaryProvider === 'groq' ? 'Missing GROQ_API_KEY' : 'Missing MODEL_API_KEY/QWEN_API_KEY');

const primaryModel: ModelConfig = { provider: primaryProvider, apiKey: primaryApiKey, baseUrl: primaryBaseUrl, model: primaryModelName };
const fallbackEnabled = process.env.FALLBACK_ENABLED !== 'false';
const fallbackProvider = (process.env.FALLBACK_PROVIDER ?? 'gemini').trim().toLowerCase();
const fallbackApiKey = fallbackProvider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.FALLBACK_API_KEY;
const fallbackBaseUrl = process.env.FALLBACK_BASE_URL ?? (fallbackProvider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : '');
const fallbackModelName = process.env.FALLBACK_MODEL ?? (fallbackProvider === 'gemini' ? 'gemini-2.5-flash' : '');
const fallbackModel: ModelConfig | null = fallbackEnabled && fallbackApiKey && fallbackBaseUrl && fallbackModelName
  ? { provider: fallbackProvider, apiKey: fallbackApiKey, baseUrl: fallbackBaseUrl, model: fallbackModelName }
  : null;

function clientFor(config: ModelConfig) {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
}

const primaryClient = clientFor(primaryModel);
const fallbackClient = fallbackModel ? clientFor(fallbackModel) : null;

function isToolArgumentError(error: unknown): boolean {
  const value = error as { status?: number; message?: string; error?: { message?: string; failed_generation?: unknown } };
  const message = `${value?.message ?? ''} ${value?.error?.message ?? ''}`;
  return value?.status === 400 && /tool call|tool_call|arguments|valid json|failed_generation/i.test(message);
}

function isTransientModelError(error: unknown): boolean {
  const value = error as { status?: number; code?: string; message?: string };
  if (value?.status === 408 || value?.status === 429 || (typeof value?.status === 'number' && value.status >= 500)) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(value?.code ?? ''))) return true;
  return /timeout|temporarily unavailable|connection reset|fetch failed/i.test(String(value?.message ?? error));
}

async function callProvider(config: ModelConfig, client: OpenAI, messages: any[], tools: any[], retryToolGeneration = false) {
  const groq = config.provider === 'groq';
  const request: any = {
    model: config.model,
    messages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    temperature: retryToolGeneration ? 0 : 0.2,
    max_completion_tokens: 2048,
  };
  if (groq) request.reasoning_effort = retryToolGeneration ? 'low' : 'medium';
  return client.chat.completions.create(request);
}

async function createCompletion(messages: any[], tools: any[]) {
  try {
    return await callProvider(primaryModel, primaryClient, messages, tools);
  } catch (error) {
    if (primaryModel.provider === 'groq' && isToolArgumentError(error)) {
      console.warn('[model] Groq rejected a generated tool call; retrying with deterministic tool-call settings.');
      try {
        return await callProvider(primaryModel, primaryClient, messages, tools, true);
      } catch (retryError) {
        error = retryError;
      }
    }
    if (!fallbackModel || !fallbackClient) throw error;
    if (!isTransientModelError(error) && !isToolArgumentError(error)) throw error;
    console.warn(`[model] ${primaryModel.provider}/${primaryModel.model} unavailable; falling back to ${fallbackModel.provider}/${fallbackModel.model}`);
    return await callProvider(fallbackModel, fallbackClient, messages, tools);
  }
}

function compactValue(value: unknown, maxChars = 10000): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= maxChars) return value;
  return { truncated: true, original_chars: serialized.length, preview: serialized.slice(0, Math.floor(maxChars * 0.75)) };
}

function compactToolResult(name: string, result: unknown): unknown {
  if (name === 'get_markets' && result && typeof result === 'object') {
    const source: any = result;
    if (Array.isArray(source.markets)) {
      return compactValue({
        ...source,
        markets: source.markets.slice(0, 20).map((market: any) => ({
          id: market?.id,
          symbol: market?.symbol ?? market?.name,
          price: market?.price ?? market?.mark_price ?? market?.index_price,
          index_price: market?.index_price,
          mark_price: market?.mark_price,
          funding: market?.funding ?? market?.funding_rate,
          ...Object.fromEntries(Object.entries(market ?? {}).filter(([key]) => /leverage|tick|step|min|max|status|contract|order_ttl/i.test(key))),
        })),
      });
    }
  }
  if (name === 'get_state' && result && typeof result === 'object') {
    const source: any = result;
    return compactValue({
      ...source,
      account: source.account ? {
        id: source.account.id,
        b: source.account.b,
        lb: source.account.lb,
        fr: source.account.fr,
        fw: source.account.fw,
        lfr: source.account.lfr,
      } : null,
      accounts: Array.isArray(source.accounts) ? source.accounts.slice(0, 8) : source.accounts,
      orders: Array.isArray(source.orders) ? source.orders.slice(-20) : source.orders,
      positions: Array.isArray(source.positions) ? source.positions.slice(-12) : source.positions,
    });
  }
  if (name === 'get_market_candles' && result && typeof result === 'object') {
    const source: any = result;
    if (Array.isArray(source.data)) return compactValue({ ...source, data: source.data.slice(-100) }, 9000);
    if (Array.isArray(source.candles)) return compactValue({ ...source, candles: source.candles.slice(-100) }, 9000);
  }
  if (name === 'get_funding' && result && typeof result === 'object') {
    const source: any = result;
    if (Array.isArray(source.data)) return compactValue({ ...source, data: source.data.slice(-80) }, 8000);
    if (Array.isArray(source.funding)) return compactValue({ ...source, funding: source.funding.slice(-80) }, 8000);
  }
  if (name === 'web_research' && result && typeof result === 'object') {
    const source: any = result;
    return compactValue({
      query: source.query,
      answer: typeof source.answer === 'string' ? source.answer.slice(0, 1200) : source.answer,
      results: Array.isArray(source.results) ? source.results.slice(0, 3).map((item: any) => ({ title: item?.title, url: item?.url, published_date: item?.published_date, content: String(item?.content ?? '').slice(0, 1000) })) : [],
    }, 6000);
  }
  if (name === 'get_trading_memory' && Array.isArray(result)) {
    return result.slice(-6).map((entry: any) => ({
      timestamp: entry.timestamp,
      action: entry.action,
      toolCalls: Array.isArray(entry.toolCalls) ? entry.toolCalls.slice(-8) : [],
      summary: String(entry.summary ?? '').slice(0, 1000),
      forecast: entry.forecast ? String(entry.forecast).slice(0, 700) : undefined,
      outcome: entry.outcome ? String(entry.outcome).slice(0, 700) : undefined,
    }));
  }
  return compactValue(result);
}

const tools = [
  { type: 'function' as const, function: { name: 'get_markets', description: 'Get live Perpl market context. This is the primary venue market-data source.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_state', description: 'Get a fresh authenticated Perpl wallet/account state including balance, available balance, orders and positions.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_market_candles', description: 'Get native Perpl OHLCV candles. Use market_id from get_markets. Resolution seconds: 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400.', parameters: { type: 'object', properties: { market_id: { type: 'integer', minimum: 1 }, resolution_seconds: { type: 'integer', enum: [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] }, from_ms: { type: 'integer', minimum: 0 }, to_ms: { type: 'integer', minimum: 0 } }, required: ['market_id', 'resolution_seconds', 'from_ms', 'to_ms'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_funding', description: 'Get native Perpl funding history for one market.', parameters: { type: 'object', properties: { market_id: { type: 'integer', minimum: 1 }, from_ms: { type: 'integer', minimum: 0 }, to_ms: { type: 'integer', minimum: 0 } }, required: ['market_id', 'from_ms', 'to_ms'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_trading_memory', description: 'Read recent agent journal entries.', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'web_research', description: 'Search recent web/news evidence relevant to a trading hypothesis.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 6 } }, required: ['query'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'place_order', description: 'Place a directly authenticated Perpl order using exact fields supported by Perpl.', parameters: { type: 'object', properties: { mkt: { type: 'integer', minimum: 1 }, t: { type: 'integer' }, s: { type: 'number' }, lv: { type: 'number' }, fl: { type: 'integer' }, p: { type: 'number' }, a: { type: 'string' }, ms: { type: 'integer' }, tif: { type: 'integer' }, tp: { type: 'number' }, tpc: { type: 'number' }, tr: { type: 'number' }, lp: { type: 'number' }, bf: { type: 'number' } }, required: ['mkt', 't', 's', 'lv', 'fl'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'cancel_order', description: 'Cancel an existing Perpl order.', parameters: { type: 'object', properties: { mkt: { type: 'integer', minimum: 1 }, oid: { type: 'integer', minimum: 1 } }, required: ['mkt', 'oid'], additionalProperties: false } } },
];

const autonomousEnabled = process.env.AUTONOMOUS_ENABLED === 'true';
const tradingEnabled = process.env.TRADING_ENABLED !== 'false';
const allowLong = process.env.ALLOW_LONG !== 'false';
const allowShort = process.env.ALLOW_SHORT !== 'false';
const maxLeverage = Math.max(0.01, Number(process.env.MAX_LEVERAGE ?? 2));

const status: AgentStatus = { running: false, enabled: autonomousEnabled, lastRunAt: null, lastResult: null, lastError: null, logs: [] };

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  status.logs.unshift(line);
  status.logs = status.logs.slice(0, 80);
}

async function runTool(name: string, args: Json): Promise<unknown> {
  let result: unknown;
  if (name === 'get_markets') result = await perpl.getMarkets();
  else if (name === 'get_state') result = await perpl.getState();
  else if (name === 'get_market_candles') result = await perpl.getMarketCandles(Number(args.market_id), Number(args.resolution_seconds), Number(args.from_ms), Number(args.to_ms));
  else if (name === 'get_funding') result = await perpl.getFunding(Number(args.market_id), Number(args.from_ms), Number(args.to_ms));
  else if (name === 'get_trading_memory') result = await loadTradingMemory(Math.min(Number(args.limit ?? 6), 6));
  else if (name === 'web_research') result = await webResearch(String(args.query ?? ''), Math.min(Number(args.max_results ?? 3), 3));
  else if (name === 'place_order') {
    if (!tradingEnabled) throw new Error('Trading is disabled by TRADING_ENABLED=false');
    const leverageHundredths = Number(args.lv ?? 0);
    if (!Number.isFinite(leverageHundredths) || leverageHundredths <= 0) throw new Error('Invalid leverage');
    if (leverageHundredths > maxLeverage * 100) throw new Error(`Requested leverage exceeds MAX_LEVERAGE=${maxLeverage}`);
    result = await perpl.placeOrder(args as any);
  } else if (name === 'cancel_order') result = await perpl.cancelOrder(Number(args.mkt), Number(args.oid));
  else throw new Error(`Unknown tool: ${name}`);
  return compactToolResult(name, result);
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
      const memory = await loadTradingMemory(6);
      const system = `You are an autonomous Perpl trading agent. Primary model=${primaryModel.provider}/${primaryModel.model}; fallback=${fallbackModel ? `${fallbackModel.provider}/${fallbackModel.model}` : 'disabled'}.
Perpl is the execution venue and the primary source of truth for account state and venue market data. Never substitute generic data when a Perpl-native tool can answer it.
Use the user strategy as the governing instruction set.
Gather focused evidence, form an explicit probability-weighted forecast and time horizon, identify disconfirming evidence, then choose long, short, management, or do nothing.
Before trading, ALWAYS call get_state and use its fresh balance/available balance/orders/positions. Never reuse an old balance from memory.
Use native Perpl candles and funding when relevant. Keep history windows focused.
Confirm account exists, has current funds, is not frozen, and has API forwarding enabled before placing an order.
Long entries are ${allowLong ? 'allowed' : 'disabled'}; short entries are ${allowShort ? 'allowed' : 'disabled'}; maximum leverage is ${maxLeverage}x; actual trading execution is ${tradingEnabled ? 'enabled' : 'disabled'}.
Do not force a trade when evidence is weak. When evidence is sufficient and the strategy supports it, execute the best supported long or short setup rather than defaulting to do nothing.
Never claim execution success unless the order tool confirms it. Never expose credentials.

USER STRATEGY:\n${strategy}\n\nRECENT MEMORY:\n${JSON.stringify(compactToolResult('get_trading_memory', memory))}`;
      const messages: any[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Run one autonomous trading cycle. Refresh Perpl state, inspect relevant native Perpl data, research only what matters, decide, and execute when justified. Finish with the key forecast, current account balance, and confidence.' },
      ];
      const maxSteps = Math.min(Math.max(Number(process.env.MAX_TOOL_STEPS ?? 8), 1), 8);
      let finalResult = 'No final response.';
      for (let step = 0; step < maxSteps; step++) {
        const response = await createCompletion(messages, tools);
        const message: any = response.choices[0]?.message;
        if (!message) throw new Error('Model returned no message');
        messages.push(message);
        if (!message.tool_calls?.length) { finalResult = String(message.content ?? finalResult); break; }
        for (const call of message.tool_calls) {
          toolNames.push(call.function.name);
          let result: unknown;
          try {
            const parsed = JSON.parse(call.function.arguments || '{}');
            result = await runTool(call.function.name, parsed);
          } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) };
          }
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
        }
        if (step === maxSteps - 1) throw new Error('Model exceeded MAX_TOOL_STEPS');
      }
      status.lastResult = finalResult;
      log(finalResult);
      await saveTradingMemory({ timestamp: new Date().toISOString(), action: toolNames.includes('place_order') ? 'trade' : 'no-trade-or-management', toolCalls: toolNames.slice(-20), summary: finalResult.slice(0, 5000) });
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      log(`Cycle failed: ${status.lastError}`);
      await saveTradingMemory({ timestamp: new Date().toISOString(), action: 'error', toolCalls: toolNames.slice(-20), summary: status.lastError });
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
  log(`Perpl direct execution configured. model=${primaryModel.provider}/${primaryModel.model} fallback=${fallbackModel ? `${fallbackModel.provider}/${fallbackModel.model}` : 'disabled'} trading=${tradingEnabled} long=${allowLong} short=${allowShort} maxLeverage=${maxLeverage}x`);
  if (status.enabled) await cycle();
  const interval = Number(process.env.TRADING_INTERVAL_MS ?? 300_000);
  if (interval > 0) setInterval(() => { if (!status.enabled || status.running) return; cycle().catch(() => undefined); }, interval);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
