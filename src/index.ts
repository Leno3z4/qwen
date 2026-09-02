import 'dotenv/config';
import OpenAI from 'openai';
import ccxt from 'ccxt';

type Decision = { action: 'buy' | 'sell' | 'hold'; amount?: number; reason: string };

const symbol = process.env.TRADING_SYMBOL ?? 'BTC/USDT';
const timeframe = process.env.TIMEFRAME ?? '5m';
const paper = (process.env.PAPER_TRADING ?? 'true').toLowerCase() !== 'false';

if (!process.env.QWEN_API_KEY) throw new Error('Missing QWEN_API_KEY');

const qwen = new OpenAI({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
});

const exchangeId = process.env.EXCHANGE ?? 'binance';
const Exchange = (ccxt as any)[exchangeId];
if (!Exchange) throw new Error(`Unsupported CCXT exchange: ${exchangeId}`);

const exchange = new Exchange({
  apiKey: process.env.EXCHANGE_API_KEY,
  secret: process.env.EXCHANGE_API_SECRET,
  password: process.env.EXCHANGE_API_PASSWORD,
  enableRateLimit: true,
  options: { defaultType: process.env.EXCHANGE_MARKET_TYPE ?? 'spot' }
});

async function marketData() {
  const ticker = await exchange.fetchTicker(symbol);
  const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 50);
  return {
    symbol,
    timeframe,
    last: ticker.last,
    bid: ticker.bid,
    ask: ticker.ask,
    change24h: ticker.percentage,
    candles: candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
  };
}

async function accountState() {
  if (paper) return { mode: 'paper', balance: 'virtual', positions: [] };
  return await exchange.fetchBalance();
}

async function executeOrder(side: 'buy' | 'sell', amount: number) {
  if (paper) return { mode: 'paper', symbol, side, amount, status: 'simulated' };
  return await exchange.createMarketOrder(symbol, side, amount);
}

const tools: any[] = [
  {
    type: 'function',
    function: {
      name: 'get_market_data',
      description: 'Get recent OHLCV candles and current ticker data for the configured market.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_account_state',
      description: 'Get the current account balance and positions. Paper mode returns a simulated state.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_order',
      description: 'Execute a market order. The application enforces paper/live mode outside the model.',
      parameters: {
        type: 'object',
        properties: { side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'number' } },
        required: ['side', 'amount'],
        additionalProperties: false
      }
    }
  }
];

const system = `You are an autonomous market-analysis agent. You operate only through the supplied tools. Analyze the configured market using fresh tool data. Make one clear decision: buy, sell, or hold. Never invent market/account data. Keep reasoning concise. The execution layer, not you, controls paper/live mode.`;

async function runAgent() {
  const messages: any[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Analyze ${symbol} on ${timeframe}. Obtain current market and account data, then decide whether to buy, sell, or hold. If trading, choose an amount that is explicitly supported by the available account state.` }
  ];

  for (let step = 0; step < 8; step++) {
    const response = await qwen.chat.completions.create({
      model: process.env.QWEN_MODEL ?? 'qwen3-max',
      messages,
      tools,
      tool_choice: 'auto'
    });

    const message: any = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log('\nAGENT:', message.content);
      return;
    }

    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || '{}');
      let result: unknown;
      if (call.function.name === 'get_market_data') result = await marketData();
      else if (call.function.name === 'get_account_state') result = await accountState();
      else if (call.function.name === 'execute_order') {
        if (!Number.isFinite(args.amount) || args.amount <= 0) throw new Error('Invalid order amount');
        result = await executeOrder(args.side, args.amount);
      } else throw new Error(`Unknown tool: ${call.function.name}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('Agent exceeded tool-call limit');
}

runAgent().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
