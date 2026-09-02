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

const modelProvider = (process.env.MODEL_PROVIDER ?? 'groq').trim().toLowerCase();
const modelApiKey = modelProvider === 'groq' ? process.env.GROQ_API_KEY : process.env.MODEL_API_KEY ?? process.env.QWEN_API_KEY;
const modelBaseUrl = process.env.MODEL_BASE_URL ?? (modelProvider === 'groq' ? 'https://api.groq.com/openai/v1' : process.env.QWEN_BASE_URL ?? 'https://openrouter.ai/api/v1');
const modelName = process.env.MODEL_NAME ?? (modelProvider === 'groq' ? 'openai/gpt-oss-120b' : process.env.QWEN_MODEL ?? 'qwen/qwen3-235b-a22b-2507:free');
if (!modelApiKey) throw new Error(modelProvider === 'groq' ? 'Missing GROQ_API_KEY' : 'Missing MODEL_API_KEY/QWEN_API_KEY');

const primaryModel: ModelConfig = { provider: modelProvider, apiKey: modelApiKey, baseUrl: modelBaseUrl, model: modelName };
const fallbackEnabled = process.env.FALLBACK_ENABLED !== 'false';
const fallbackProvider = (process.env.FALLBACK_PROVIDER ?? 'gemini').trim().toLowerCase();
const fallbackApiKey = fallbackProvider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.FALLBACK_API_KEY;
const fallbackBaseUrl = process.env.FALLBACK_BASE_URL ?? (fallbackProvider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : '');
const fallbackModel = process.env.FALLBACK_MODEL ?? (fallbackProvider === 'gemini' ? 'gemini-2.5-flash' : '');
const fallbackModelConfig: ModelConfig | null = fallbackEnabled && fallbackApiKey && fallbackModel && fallbackBaseUrl
  ? { provider: fallbackProvider, apiKey: fallbackApiKey, baseUrl: fallbackBaseUrl, model: fallbackModel }
  : null;

function createClient(config: ModelConfig) {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
}

const primaryClient = createClient(primaryModel);
const fallbackClient = fallbackModelConfig ? createClient(fallbackModelConfig) : null;

function shouldFallback(error: unknown): boolean {
  if (!fallbackModelConfig || !fallbackClient) return false;
  const value = error as { status?: number; code?: string; message?: string };
  if (value?.status === 429 || value?.status === 408 || (typeof value?.status === 'number' && value.status >= 500)) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(value?.code ?? ''))) return true;
  return /timeout|timed out|temporarily unavailable|connection reset|fetch failed/i.test(String(value?.message ?? error));
}

async function createCompletion(messages: any[], tools: any[]) {
  try {
    return await primaryClient.chat.completions.create({ model: primaryModel.model, messages, tools, tool_choice: 'auto' });
  } catch (error) {
    if (!shouldFallback(error)) throw error;
    console.warn(`[model] ${primaryModel.provider}/${primaryModel.model} unavailable; falling back to ${fallbackModelConfig!.provider}/${fallbackModelConfig!.model}`);
    return await fallbackClient!.chat.completions.create({ model: fallbackModelConfig!.model, messages, tools, tool_choice: 'auto' });
  }
}

const tools = [
  { type: 'function' as const, function: { name: 'get_markets', description: 'Get the live Perpl market context from Perpl itself: markets, prices, funding and trading configuration. Treat this as the primary venue data source.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_state', description: 'Get a FRESH authenticated Perpl wallet/account state. This reconnects to Perpl before reading state so balance, account, open orders and positions reflect the latest exchange state, not a stale snapshot.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_market_candles', description: 'Get native Perpl OHLCV candles directly from the Perpl REST market-data endpoint. Use market_id from get_markets. Resolution is seconds: 60=1m, 300=5m, 900=15m, 1800=30m, 3600=1h, 7200=2h, 14400=4h, 28800=8h, 43200=12h, 86400=1d. Maximum 1024 candles per request.', parameters: { type: 'object', properties: { market_id: { type: 'integer', minimum: 1 }, resolution_seconds: { type: 'integer', enum: [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] }, from_ms: { type: 'integer', minimum: 0 }, to_ms: { type: 'integer', minimum: 0 } }, required: ['market_id', 'resolution_seconds', 'from_ms', 'to_ms'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_funding', description: 'Get native Perpl funding history directly from Perpl for one market. Use this for funding regime analysis instead of relying only on third-party data.', parameters: { type: 'object', properties: { market_id: { type: 'integer', minimum: 1 }, from_ms: { type: 'integer', minimum: 0 }, to_ms: { type: 'integer', minimum: 0 } }, required: ['market_id', 'from_ms', 'to_ms'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_trading_memory', description: 'Read the agent journal from previous cycles. Use it to learn from prior decisions, research summaries and execution outcomes.', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'web_research', description: 'Search the live web for recent news and analysis relevant to a trading hypothesis. Prefer several independent sources and use this before making a market-moving decision.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'place_order', description: 'Place a directly authenticated Perpl order. Use exact market id and Perpl order parameters returned by get_markets/get_state. Size and price are Perpl scaled integers, leverage is hundredths (1000 = 10x).', parameters: { type: 'object', properties: { mkt: { type: 'integer' }, t: { type: 'integer' }, s: { type: 'number' }, lv: { type: 'number' }, fl: { type: 'integer' }, p: { type: 'number' }, a: { type: 'string' }, ms: { type: 'integer' }, tif: { type: 'integer' }, tp: { type: 'number' }, tpc: { type: 'number' }, tr: { type: 'number' }, lp: { type: 'number' }, bf: { type: 'number' } }, required: ['mkt', 't', 's', 'lv', 'fl'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'cancel_order', description: 'Cancel an existing Perpl order directly over the authenticated trading WebSocket.', parameters: { type: 'object', properties: { mkt: { type: 'integer' }, oid: { type: 'integer' } }, required: ['mkt', 'oid'], additionalProperties: false } } },
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
  if (name === 'get_markets') return perpl.getMarkets();
  if (name === 'get_state') return perpl.getState();
  if (name === 'get_market_candles') return perpl.getMarketCandles(Number(args.market_id), Number(args.resolution_seconds), Number(args.from_ms), Number(args.to_ms));
  if (name === 'get_funding') return perpl.getFunding(Number(args.market_id), Number(args.from_ms), Number(args.to_ms));
  if (name === 'get_trading_memory') return loadTradingMemory(Number(args.limit ?? 20));
  if (name === 'web_research') return webResearch(String(args.query ?? ''), Number(args.max_results ?? 6));
  if (name === 'place_order') {
    if (!tradingEnabled) throw new Error('Trading is disabled by TRADING_ENABLED=false');
    const leverageHundredths = Number(args.lv ?? 0);
    if (!Number.isFinite(leverageHundredths) || leverageHundredths <= 0) throw new Error('Invalid leverage');
    if (leverageHundredths > maxLeverage * 100) throw new Error(`Requested leverage exceeds MAX_LEVERAGE=${maxLeverage}`);
    return perpl.placeOrder(args as any);
  }
  if (name === 'cancel_order') return perpl.cancelOrder(Number(args.mkt), Number(args.oid));
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
      const fallbackDescription = fallbackModelConfig ? ` Primary=${primaryModel.provider}/${primaryModel.model}; fallback=${fallbackModelConfig.provider}/${fallbackModelConfig.model}.` : ` Primary=${primaryModel.provider}/${primaryModel.model}; no fallback configured.`;
      const system = `You are an autonomous Perpl trading agent using the configured model provider.${fallbackDescription}
Perpl is the execution venue and the primary source of truth for venue state and market data. Do not substitute generic web data for Perpl-native account, market, candle, or funding data when a Perpl tool can provide it.
There is no AgentHub execution path.
Your Perpl API key is server-side and the trading client signs requests with its Ed25519 private key. Never ask for, print, or expose credentials.
Use the user strategy as the governing instruction set.
Use a forecasting-first workflow inspired by FutureBench: gather current evidence from Perpl plus the live web, form explicit probability-weighted hypotheses with a time horizon, identify disconfirming evidence, then decide whether the evidence justifies an action.
Do not treat web articles, prediction markets, or model opinions as facts. Prefer primary/first-party sources when possible and seek independent corroboration.
Before trading, ALWAYS call get_state and use its fresh balance/available_balance/accounts/positions/orders values. Never carry forward an old balance from memory or a previous cycle.
Use get_market_candles for native Perpl price history and get_funding for native Perpl funding history when relevant to the forecast.
Confirm the account exists, has current funds, is not frozen, and has API forwarding enabled before sending an order.
Use prior journal entries to identify repeated mistakes or successful patterns, but do not blindly copy prior actions.
You may buy, sell, cancel, or do nothing. Long entries are ${allowLong ? 'allowed' : 'disabled'}; short entries are ${allowShort ? 'allowed' : 'disabled'}; maximum leverage is ${maxLeverage}x. Trading execution is ${tradingEnabled ? 'enabled' : 'disabled'}.
Do not force a trade when the evidence does not support one. When evidence is sufficient, choose the best supported long or short setup and execute it rather than defaulting to do nothing.
Only use exact Perpl order fields supported by the tools. Do not claim success unless a tool returned success.

USER-PROVIDED STRATEGY:\n${strategy}\n\nRECENT TRADING MEMORY:\n${JSON.stringify(memory)}`;
      const messages: any[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Run one autonomous trading cycle. Research what matters, refresh Perpl account state, inspect native Perpl market/candle/funding data, form explicit forecasts, compare against prior experience, then take an action only when the strategy and evidence support it. Finish with a concise explanation including the key forecast, current account balance, and confidence.' },
      ];
      const maxSteps = Number(process.env.MAX_TOOL_STEPS ?? 10);
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
          try { result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}')); }
          catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (step === maxSteps - 1) throw new Error('Model exceeded MAX_TOOL_STEPS');
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
  log(`Direct Perpl trading client configured. primary=${primaryModel.provider}/${primaryModel.model} fallback=${fallbackModelConfig ? `${fallbackModelConfig.provider}/${fallbackModelConfig.model}` : 'disabled'} trading=${tradingEnabled} long=${allowLong} short=${allowShort} maxLeverage=${maxLeverage}x`);
  if (status.enabled) await cycle();
  const interval = Number(process.env.TRADING_INTERVAL_MS ?? 300_000);
  if (interval > 0) setInterval(() => { if (!status.enabled || status.running) return; cycle().catch(() => undefined); }, interval);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
