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
const primaryApiKey = primaryProvider === 'groq' ? process.env.GROQ_API_KEY : process.env.MODEL_API_KEY ?? process.env.QWEN_API_KEY ?? process.env.OPENROUTER_API_KEY;
const primaryBaseUrl = process.env.MODEL_BASE_URL ?? (primaryProvider === 'groq' ? 'https://api.groq.com/openai/v1' : process.env.QWEN_BASE_URL ?? 'https://openrouter.ai/api/v1');
const primaryModelName = process.env.MODEL_NAME ?? (primaryProvider === 'groq' ? 'openai/gpt-oss-120b' : process.env.QWEN_MODEL ?? 'qwen/qwen3-235b-a22b-2507:free');
if (!primaryApiKey) throw new Error(primaryProvider === 'groq' ? 'Missing GROQ_API_KEY' : 'Missing MODEL_API_KEY/QWEN_API_KEY/OPENROUTER_API_KEY');

const primaryModel: ModelConfig = { provider: primaryProvider, apiKey: primaryApiKey, baseUrl: primaryBaseUrl, model: primaryModelName };
const fallbackEnabled = process.env.FALLBACK_ENABLED !== 'false';
const fallbackProvider = (process.env.FALLBACK_PROVIDER ?? 'gemini').trim().toLowerCase();
const fallbackApiKey = fallbackProvider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.FALLBACK_API_KEY;
const fallbackBaseUrl = process.env.FALLBACK_BASE_URL ?? (fallbackProvider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : '');
const fallbackModelName = process.env.FALLBACK_MODEL ?? (fallbackProvider === 'gemini' ? 'gemini-2.5-flash-lite' : '');
const fallbackModel: ModelConfig | null = fallbackEnabled && fallbackApiKey && fallbackBaseUrl && fallbackModelName
  ? { provider: fallbackProvider, apiKey: fallbackApiKey, baseUrl: fallbackBaseUrl, model: fallbackModelName }
  : null;

function clientFor(config: ModelConfig) {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
}

const primaryClient = clientFor(primaryModel);
const fallbackClient = fallbackModel ? clientFor(fallbackModel) : null;
let primaryCooldownUntil = 0;
let fallbackCooldownUntil = 0;
let fallbackCooldownReason = '';
let cycleModelCalls = 0;
let cycleFallbackCalls = 0;

const configuredMaxStepsRaw = Number(process.env.MAX_TOOL_STEPS ?? 20);
const configuredMaxSteps = Number.isFinite(configuredMaxStepsRaw) ? Math.min(Math.max(Math.floor(configuredMaxStepsRaw), 1), 300) : 20;

function isToolArgumentError(error: unknown): boolean {
  const value = error as { status?: number; message?: string; error?: { message?: string; failed_generation?: unknown } };
  const message = `${value?.message ?? ''} ${value?.error?.message ?? ''}`;
  return value?.status === 400 && /tool call|tool_call|arguments|valid json|failed_generation/i.test(message);
}

function errorSummary(error: unknown): string {
  const value = error as { status?: number; code?: string; message?: string; error?: { message?: string } };
  const status = value?.status !== undefined ? `status=${value.status}` : '';
  const code = value?.code ? ` code=${value.code}` : '';
  const message = String(value?.message ?? value?.error?.message ?? error);
  return `${status}${code} ${message}`.trim();
}

function isTransientModelError(error: unknown): boolean {
  const value = error as { status?: number; code?: string; message?: string };
  if (value?.status === 408 || value?.status === 413 || value?.status === 429 || (typeof value?.status === 'number' && value.status >= 500)) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(value?.code ?? ''))) return true;
  return /timeout|temporarily unavailable|connection reset|request too large|context length|too many tokens|fetch failed|service unavailable/i.test(String(value?.message ?? error));
}

function parseRetryDelayMs(error: unknown): number | null {
  const text = errorSummary(error);
  const match = text.match(/try again in\s+(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  const total = (minutes * 60 + seconds) * 1000;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 120))}\n...[truncated ${text.length - maxChars} chars]...`;
}

function compactMessages(messages: any[], maxChars: number): any[] {
  const first = messages.slice(0, 2).map((message) => ({
    ...message,
    content: message.content === undefined ? message.content : compactText(message.content, Math.min(7000, Math.floor(maxChars * 0.42))),
  }));
  const recent = messages.slice(2);
  const kept: any[] = [];
  let chars = first.reduce((total, message) => total + JSON.stringify(message).length, 0);
  const perMessage = Math.min(2800, Math.max(1000, Math.floor(maxChars * 0.22)));
  for (let i = recent.length - 1; i >= 0; i--) {
    const copy: any = { ...recent[i] };
    if (copy.content !== undefined) copy.content = compactText(copy.content, perMessage);
    const serializedLength = JSON.stringify(copy).length;
    if (chars + serializedLength > maxChars) break;
    kept.unshift(copy);
    chars += serializedLength;
  }
  return [...first, ...kept];
}

async function callProvider(config: ModelConfig, client: OpenAI, messages: any[], tools: any[], retryToolGeneration = false) {
  const groq = config.provider === 'groq';
  const messageBudget = groq ? 14000 : 14000;
  const boundedMessages = compactMessages(messages, messageBudget);
  const request: any = {
    model: config.model,
    messages: boundedMessages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_completion_tokens: groq ? 1024 : 1024,
  };
  if (groq) {
    request.temperature = retryToolGeneration ? 0 : 0.2;
    request.reasoning_effort = retryToolGeneration ? 'low' : 'medium';
  }
  console.log(`[model] request provider=${config.provider} model=${config.model} messages_chars=${JSON.stringify(boundedMessages).length} tools_chars=${JSON.stringify(tools).length} max_completion_tokens=${request.max_completion_tokens}`);
  return client.chat.completions.create(request);
}

async function callFallback(messages: any[], tools: any[]) {
  if (!fallbackModel || !fallbackClient) throw new Error('Fallback model is not configured');
  if (Date.now() < fallbackCooldownUntil) {
    const remaining = Math.ceil((fallbackCooldownUntil - Date.now()) / 1000);
    throw new Error(`Fallback ${fallbackModel.provider}/${fallbackModel.model} is cooling down for ${remaining}s${fallbackCooldownReason ? ` (${fallbackCooldownReason})` : ''}`);
  }
  cycleFallbackCalls += 1;
  try {
    return await callProvider(fallbackModel, fallbackClient, messages, tools);
  } catch (error) {
    const statusCode = (error as { status?: number })?.status;
    console.error(`[model] fallback ${fallbackModel.provider}/${fallbackModel.model} failed: ${errorSummary(error)}`);
    if (!isTransientModelError(error)) throw error;
    const retryDelay = parseRetryDelayMs(error);
    if (statusCode === 429) {
      const cooldown = Math.min(Math.max(retryDelay ?? 10 * 60_000, 60_000), 60 * 60_000);
      fallbackCooldownUntil = Date.now() + cooldown;
      fallbackCooldownReason = 'rate limited; no retry storm';
      console.warn(`[model] ${fallbackModel.provider}/${fallbackModel.model} rate-limited; cooling fallback for ${Math.ceil(cooldown / 1000)}s and ending this cycle`);
      throw error;
    }
    if (retryDelay !== null && retryDelay > 10_000) throw error;
    if (isTransientModelError(error) && cycleFallbackCalls < 2) {
      const delay = retryDelay ?? 1500;
      await sleep(Math.min(delay, 5000));
      cycleFallbackCalls += 1;
      try {
        return await callProvider(fallbackModel, fallbackClient, messages, tools);
      } catch (retryError) {
        console.error(`[model] fallback ${fallbackModel.provider}/${fallbackModel.model} retry failed: ${errorSummary(retryError)}`);
        throw retryError;
      }
    }
    throw error;
  }
}

async function createCompletion(messages: any[], tools: any[]) {
  if (cycleModelCalls >= configuredMaxSteps) throw new Error('Cycle model-call budget exhausted; stopping to protect provider quotas');
  if (fallbackModel && fallbackClient && Date.now() < primaryCooldownUntil) {
    if (Date.now() < fallbackCooldownUntil) {
      throw new Error(`Primary and fallback are cooling down; stopping this cycle${fallbackCooldownReason ? ` (${fallbackCooldownReason})` : ''}`);
    }
    console.warn(`[model] primary ${primaryModel.provider}/${primaryModel.model} is cooling down; using fallback without another primary request`);
    cycleModelCalls += 1;
    return await callFallback(messages, tools);
  }
  cycleModelCalls += 1;
  try {
    return await callProvider(primaryModel, primaryClient, messages, tools);
  } catch (error) {
    console.warn(`[model] primary ${primaryModel.provider}/${primaryModel.model} failed: ${errorSummary(error)}`);
    if (primaryModel.provider === 'groq' && isToolArgumentError(error)) {
      console.warn('[model] Groq rejected a generated tool call; retrying with deterministic tool-call settings.');
      try {
        cycleModelCalls += 1;
        return await callProvider(primaryModel, primaryClient, messages, tools, true);
      } catch (retryError) {
        console.warn(`[model] Groq deterministic retry failed: ${errorSummary(retryError)}`);
        error = retryError;
      }
    }
    if (!fallbackModel || !fallbackClient) throw error;
    if (!isTransientModelError(error) && !isToolArgumentError(error)) throw error;
    const retryDelay = parseRetryDelayMs(error);
    const cooldown = Math.min(Math.max(retryDelay ?? 120_000, 60_000), 20 * 60_000);
    primaryCooldownUntil = Date.now() + cooldown;
    console.warn(`[model] ${primaryModel.provider}/${primaryModel.model} unavailable; cooling primary for ${Math.ceil(cooldown / 1000)}s and falling back to ${fallbackModel.provider}/${fallbackModel.model}`);
    if (Date.now() < fallbackCooldownUntil) {
      throw new Error(`Primary ${primaryModel.provider}/${primaryModel.model} and fallback ${fallbackModel.provider}/${fallbackModel.model} are unavailable right now`);
    }
    if (cycleModelCalls >= configuredMaxSteps) throw new Error('No model-call budget remains for fallback; stopping this cycle');
    cycleModelCalls += 1;
    return await callFallback(messages, tools);
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
      return compactValue({ ...source, markets: source.markets.slice(0, 40).map((market: any) => ({ id: market?.id, symbol: market?.symbol ?? market?.name, price: market?.price ?? market?.mark_price ?? market?.index_price, index_price: market?.index_price, mark_price: market?.mark_price, funding: market?.funding ?? market?.funding_rate, open: market?.state?.is_open ?? market?.is_open, ...Object.fromEntries(Object.entries(market ?? {}).filter(([key]) => /leverage|tick|step|min|max|status|contract|order_ttl/i.test(key))) })) });
    }
  }
  if (name === 'get_state' && result && typeof result === 'object') {
    const source: any = result;
    return compactValue({ ...source, account: source.account ? { id: source.account.id, b: source.account.b, lb: source.account.lb, fr: source.account.fr, fw: source.account.fw, lfr: source.account.lfr } : null, accounts: Array.isArray(source.accounts) ? source.accounts.slice(0, 8) : source.accounts, orders: Array.isArray(source.orders) ? source.orders.slice(-30) : source.orders, positions: Array.isArray(source.positions) ? source.positions.slice(-30) : source.positions });
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
    return compactValue({ query: source.query, answer: typeof source.answer === 'string' ? source.answer.slice(0, 1200) : source.answer, results: Array.isArray(source.results) ? source.results.slice(0, 3).map((item: any) => ({ title: item?.title, url: item?.url, published_date: item?.published_date, content: String(item?.content ?? '').slice(0, 1000) })) : [] }, 6000);
  }
  if (name === 'get_trading_memory' && Array.isArray(result)) {
    return result.slice(-6).map((entry: any) => ({ timestamp: entry.timestamp, action: entry.action, toolCalls: Array.isArray(entry.toolCalls) ? entry.toolCalls.slice(-8) : [], summary: String(entry.summary ?? '').slice(0, 1000), forecast: entry.forecast ? String(entry.forecast).slice(0, 700) : undefined, outcome: entry.outcome ? String(entry.outcome).slice(0, 700) : undefined }));
  }
  return compactValue(result);
}

const tools = [
  { type: 'function' as const, function: { name: 'get_markets', description: 'Get live Perpl market context for the whole venue. Inspect multiple markets; do not default to HYPE.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_state', description: 'Get a fresh authenticated Perpl portfolio state including ALL current accounts, open orders, and ALL open positions. Use this before every trade decision.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_market_candles', description: 'Get native Perpl OHLCV candles. Use market_id from get_markets. Resolution seconds: 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400.', parameters: { type: 'object', properties: { market_id: { type: 'integer', minimum: 1 }, resolution_seconds: { type: 'integer', enum: [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] }, from_ms: { type: 'integer', minimum: 0 }, to_ms: { type: 'integer', minimum: 0 } }, required: ['market_id', 'resolution_seconds', 'from_ms', 'to_ms'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_funding', description: 'Get native Perpl funding history for one market.', parameters: { type: 'object', properties: { market_id: { type: 'integer', minimum: 1 }, from_ms: { type: 'integer', minimum: 0 }, to_ms: { type: 'integer', minimum: 0 } }, required: ['market_id', 'from_ms', 'to_ms'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'get_trading_memory', description: 'Read recent agent journal entries. Use it for lessons, not stale account state.', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'web_research', description: 'Search recent web/news evidence relevant to a trading hypothesis.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 6 } }, required: ['query'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'place_order', description: 'Place a Perpl order. t=1 OpenLong, t=2 OpenShort, t=3 CloseLong, t=4 CloseShort. For close orders, set lp to the exact position id and s to the amount to close. Multiple orders can be placed in one cycle.', parameters: { type: 'object', properties: { mkt: { type: 'integer', minimum: 1 }, t: { type: 'integer', enum: [1, 2, 3, 4] }, s: { type: 'number', minimum: 0 }, lv: { type: 'number', minimum: 0 }, fl: { type: 'integer', minimum: 0 }, p: { type: 'number' }, a: { type: 'string' }, ms: { type: 'integer' }, tif: { type: 'integer' }, tp: { type: 'number' }, tpc: { type: 'number' }, tr: { type: 'number' }, lp: { type: 'integer', minimum: 1 }, bf: { type: 'number' } }, required: ['mkt', 't', 's', 'lv', 'fl'], additionalProperties: false } } },
  { type: 'function' as const, function: { name: 'manage_position', description: 'Reduce or fully close ONE existing Perpl position by exact position id. Use this for precise per-position management. Repeat for multiple positions in the same cycle when justified.', parameters: { type: 'object', properties: { position_id: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['reduce', 'close'] }, size: { type: 'number', minimum: 0 } }, required: ['position_id', 'action'], additionalProperties: false } } },
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
    const orderType = Number(args.t);
    const size = Number(args.s);
    const leverageHundredths = Number(args.lv ?? 0);
    if (![1, 2, 3, 4].includes(orderType)) throw new Error('Invalid order type; use 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort');
    if (!Number.isFinite(size) || size <= 0) throw new Error('Invalid order size');
    if (!Number.isFinite(leverageHundredths) || leverageHundredths <= 0) throw new Error('Invalid leverage');
    if (leverageHundredths > maxLeverage * 100) throw new Error(`Requested leverage exceeds MAX_LEVERAGE=${maxLeverage}`);
    if (orderType === 1 && !allowLong) throw new Error('Long entries are disabled by ALLOW_LONG=false');
    if (orderType === 2 && !allowShort) throw new Error('Short entries are disabled by ALLOW_SHORT=false');
    if (orderType === 3 || orderType === 4) {
      const linkedPositionId = Number(args.lp ?? 0);
      if (!Number.isFinite(linkedPositionId) || linkedPositionId <= 0) throw new Error('Close orders require lp=exact position id');
      const state: any = await perpl.getState();
      const positions = Array.isArray(state?.positions) ? state.positions : [];
      const position: any = positions.find((item: any) => Number(item?.pid) === linkedPositionId);
      if (!position) throw new Error(`Position ${linkedPositionId} is not open or is not in current Perpl state`);
      const expectedType = Number(position.sd) === 1 ? 3 : Number(position.sd) === 2 ? 4 : 0;
      if (expectedType !== orderType) throw new Error(`Order type ${orderType} does not match position ${linkedPositionId}`);
      const positionSize = Number(position.s);
      if (!Number.isFinite(positionSize) || positionSize <= 0 || size > positionSize) throw new Error(`Close size ${size} exceeds position ${linkedPositionId} size ${positionSize}`);
    }
    result = await perpl.placeOrder({ ...args, mkt: Number(args.mkt), t: orderType, s: size, lv: leverageHundredths, fl: Number(args.fl) } as any);
  } else if (name === 'manage_position') {
    if (!tradingEnabled) throw new Error('Trading is disabled by TRADING_ENABLED=false');
    const positionId = Number(args.position_id);
    if (!Number.isInteger(positionId) || positionId <= 0) throw new Error('Invalid position_id');
    const state: any = await perpl.getState();
    const positions = Array.isArray(state?.positions) ? state.positions : [];
    const position: any = positions.find((item: any) => Number(item?.pid) === positionId);
    if (!position) throw new Error(`Position ${positionId} is not open or is not in current Perpl state`);
    const side = Number(position.sd);
    const orderType = side === 1 ? 3 : side === 2 ? 4 : 0;
    if (!orderType) throw new Error(`Position ${positionId} has unknown side`);
    const positionSize = Number(position.s);
    if (!Number.isFinite(positionSize) || positionSize <= 0) throw new Error(`Position ${positionId} has invalid size`);
    const action = String(args.action ?? 'close');
    const requestedSize = action === 'close' ? positionSize : Number(args.size ?? 0);
    if (!Number.isFinite(requestedSize) || requestedSize <= 0 || requestedSize > positionSize) throw new Error(`Invalid management size for position ${positionId}`);
    const leverage = Number(position.lv ?? 0);
    if (!Number.isFinite(leverage) || leverage <= 0) throw new Error(`Position ${positionId} has invalid leverage`);
    result = await perpl.placeOrder({ mkt: Number(position.mkt), t: orderType, s: requestedSize, lv: leverage, fl: 0, p: 0, lp: positionId } as any);
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
    cycleModelCalls = 0;
    cycleFallbackCalls = 0;
    const toolNames: string[] = [];
    try {
      const strategy = await loadStrategy();
      const memory = await loadTradingMemory(6);
      const system = `You are an autonomous Perpl portfolio trading agent. Primary model=${primaryModel.provider}/${primaryModel.model}; fallback=${fallbackModel ? `${fallbackModel.provider}/${fallbackModel.model}` : 'disabled'}. Perpl is the execution venue and the primary source of truth for account state and venue market data. Never substitute generic data when a Perpl-native tool can answer it.\nUse the user strategy as the governing instruction set.\n\nPORTFOLIO OPERATING RULES:\n- Think in terms of the WHOLE PORTFOLIO, not one favorite market.\n- Before every trade decision ALWAYS call get_state and inspect ALL open positions and ALL open orders.\n- Existing positions are independent objects identified by position id (pid). Evaluate each one separately: hold, reduce, fully close, or keep managing it.\n- You may manage MULTIPLE positions in the same cycle. Do not stop after handling one position if other positions also need attention.\n- You may open positions in MULTIPLE markets in the same cycle when the evidence and strategy justify them. Do not default to HYPE; compare the available Perpl markets and trade the best supported setups.\n- When reducing or closing a position, use its exact pid. manage_position is the preferred tool for precise reduction/closure.\n- For a long position, close with t=3; for a short position, close with t=4. Never use the opposite close type.\n- Do not accidentally open a new position when intending to close/reduce one. Close/reduce only against the exact existing pid.\n- Check total portfolio exposure, overlapping/correlated positions, and available balance before adding new exposure.\n- If several positions are valid, manage them one by one and re-check state as needed. Tool calls are sequential.\n- Never assume there is only one position, one order, or one market worth trading.\n\nDECISION PROCESS:\nGather focused evidence, compare relevant markets, form an explicit probability-weighted forecast and time horizon, identify disconfirming evidence, then choose entries, position management, or do nothing.\nUse native Perpl candles and funding when relevant. Keep history windows focused.\nConfirm account exists, has current funds, is not frozen, and has API forwarding enabled before placing an order.\nLong entries are ${allowLong ? 'allowed' : 'disabled'}; short entries are ${allowShort ? 'allowed' : 'disabled'}; maximum leverage is ${maxLeverage}x; actual trading execution is ${tradingEnabled ? 'enabled' : 'disabled'}.\nDo not force a trade when evidence is weak. When evidence is sufficient and the strategy supports it, execute the best supported setups, including multiple positions when justified, rather than defaulting to do nothing.\nNever claim execution success unless the order tool confirms it. Never expose credentials.\n\nUSER STRATEGY:\n${strategy}\n\nRECENT MEMORY:\n${JSON.stringify(compactToolResult('get_trading_memory', memory))}`;
      const messages: any[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Run one autonomous portfolio cycle. First refresh Perpl state and review every current position/order. Compare multiple available markets rather than anchoring on HYPE. Manage existing positions first when needed, then consider new entries. You may take multiple justified actions in this cycle. Finish with the key forecast, portfolio state, actions taken, and confidence.' },
      ];
      const maxSteps = configuredMaxSteps;
      let finalResult = 'No final response.';
      for (let step = 0; step < maxSteps; step++) {
        console.log(`[cycle] step=${step + 1}/${maxSteps} model_calls=${cycleModelCalls}`);
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
        if (step === maxSteps - 1) {
          finalResult = `Cycle reached MAX_TOOL_STEPS=${maxSteps} before the model returned a final response. Tool calls: ${toolNames.slice(-20).join(', ')}`;
          log(finalResult);
        }
      }
      status.lastResult = finalResult;
      log(finalResult);
      await saveTradingMemory({ timestamp: new Date().toISOString(), action: toolNames.includes('place_order') || toolNames.includes('manage_position') ? 'trade' : 'no-trade-or-management', toolCalls: toolNames.slice(-20), summary: finalResult.slice(0, 5000) });
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
  log(`Perpl direct execution configured. model=${primaryModel.provider}/${primaryModel.model} fallback=${fallbackModel ? `${fallbackModel.provider}/${fallbackModel.model}` : 'disabled'} trading=${tradingEnabled} long=${allowLong} short=${allowShort} maxLeverage=${maxLeverage}x maxToolSteps=${configuredMaxSteps}`);
  const interval = Number(process.env.TRADING_INTERVAL_MS ?? 300_000);

  // Arm the scheduler before the startup cycle. A failed startup/model cycle
  // must never prevent future autonomous cycles from being scheduled.
  const runScheduledCycle = async (source: 'startup' | 'interval') => {
    if (!status.enabled || status.running) return;

    log(`Autonomous cycle trigger source=${source}.`);
    try {
      await cycle();
    } catch (error) {
      // Never let a cycle failure terminate the autonomous scheduler.
      log(`Autonomous cycle error (scheduler continuing): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (interval > 0) {
    setInterval(() => {
      void runScheduledCycle('interval');
    }, interval);
    log(`Autonomous scheduler armed. interval=${interval}ms.`);
  }

  if (status.enabled) {
    void runScheduledCycle('startup');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });