// Render/OpenRouter compatibility: agent.ts historically reads MODEL_API_KEY/QWEN_API_KEY.
// Accept the native OPENROUTER_API_KEY name too without ever logging the secret.
if (!process.env.MODEL_API_KEY && process.env.OPENROUTER_API_KEY) {
  process.env.MODEL_API_KEY = process.env.OPENROUTER_API_KEY;
}

const originalFetch = globalThis.fetch.bind(globalThis);
const GEMINI_OPENAI_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const MODEL_ENDPOINTS = [
  'https://openrouter.ai/api/v1/',
  GEMINI_OPENAI_PREFIX,
  'https://api.groq.com/openai/v1/',
];

function textContent(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function formatUsdc(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const raw = String(value);
  const n = Number(raw);
  if (!Number.isFinite(n)) return value;
  return `${(n / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
}

function normalizeAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return account;
  const out = { ...account };
  if (out.b !== undefined) {
    out.balance_usdc = formatUsdc(out.b);
    delete out.b;
  }
  if (out.lb !== undefined) {
    out.locked_balance_usdc = formatUsdc(out.lb);
    delete out.lb;
  }
  if (out.balance !== undefined) {
    out.balance_usdc = formatUsdc(out.balance);
    delete out.balance;
  }
  if (out.locked_balance !== undefined) {
    out.locked_balance_usdc = formatUsdc(out.locked_balance);
    delete out.locked_balance;
  }
  if (out.available_balance !== undefined) {
    out.available_balance_usdc = formatUsdc(out.available_balance);
    delete out.available_balance;
  }
  return out;
}

function normalizeStatePayload(content) {
  if (typeof content !== 'string') return content;
  let value;
  try { value = JSON.parse(content); } catch { return content; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return content;

  const out = { ...value };
  if (out.account) out.account = normalizeAccount(out.account);
  if (Array.isArray(out.accounts)) out.accounts = out.accounts.map(normalizeAccount);
  if (out.balance !== undefined) {
    out.balance_usdc = formatUsdc(out.balance);
    delete out.balance;
  }
  if (out.locked_balance !== undefined) {
    out.locked_balance_usdc = formatUsdc(out.locked_balance);
    delete out.locked_balance;
  }
  if (out.available_balance !== undefined) {
    out.available_balance_usdc = formatUsdc(out.available_balance);
    delete out.available_balance;
  }
  return JSON.stringify(out);
}

function normalizeToolContent(name, content) {
  if (name === 'get_state') return normalizeStatePayload(content);
  return content;
}

function normalizeMessages(messages, preserveRoles = false) {
  const normalized = [];
  let toolResults = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;

    if (message.role === 'tool') {
      const content = normalizeToolContent(String(message.name ?? 'unknown'), textContent(message.content));
      if (preserveRoles) {
        normalized.push({ ...message, content });
      } else {
        toolResults.push(`[Tool result: ${String(message.name ?? 'unknown')}]\n${content}`);
      }
      continue;
    }

    if (message.role === 'assistant' && !preserveRoles) {
      const content = textContent(message.content);
      if (content) normalized.push({ role: 'assistant', content });
      if (message.tool_calls?.length) {
        const calls = message.tool_calls.map((call) => {
          const name = call?.function?.name ?? 'unknown';
          const args = call?.function?.arguments ?? '{}';
          return `[Previous tool request: ${name}] ${args}`;
        }).join('\n');
        normalized.push({ role: 'user', content: calls });
      }
      continue;
    }

    if (preserveRoles) {
      if (message.role === 'assistant' || message.role === 'system' || message.role === 'user') {
        normalized.push({ ...message, content: textContent(message.content) });
      }
    } else if (message.role === 'system' || message.role === 'user') {
      normalized.push({ role: message.role, content: textContent(message.content) });
    }
  }

  if (!preserveRoles && toolResults.length) {
    normalized.push({ role: 'user', content: toolResults.join('\n\n') });
  }

  return normalized;
}

function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'additionalProperties' || key === 'minimum' || key === 'maximum') continue;
    out[key] = sanitizeSchema(child);
  }
  return out;
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    if (tool.type !== 'function' || !tool.function) return tool;
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeSchema(tool.function.parameters),
      },
    };
  });
}

function rewriteBody(rawBody, isGemini) {
  if (!rawBody) return null;
  let body;
  try { body = JSON.parse(rawBody); } catch { return null; }

  body.messages = normalizeMessages(body.messages, !isGemini);
  body.tools = sanitizeTools(body.tools);

  if (isGemini) {
    delete body.parallel_tool_calls;
    delete body.tool_choice;
    body.reasoning_effort = 'low';
  }

  return JSON.stringify(body);
}

globalThis.fetch = async function patchedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const endpoint = MODEL_ENDPOINTS.find((prefix) => url.startsWith(prefix));
  if (!endpoint) return originalFetch(input, init);

  const isGemini = endpoint === GEMINI_OPENAI_PREFIX;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const originalBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  const rewrittenBody = rewriteBody(typeof originalBody === 'string' ? originalBody : null, isGemini);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

  if (isGemini && !headers.has('x-goog-api-client')) headers.set('x-goog-api-client', 'qwen-autonomous-agent/0.3.1');

  const requestInit = { ...init, method, headers, body: rewrittenBody ?? originalBody };
  if (rewrittenBody) {
    const parsed = JSON.parse(rewrittenBody);
    console.log(`[model] context normalization applied provider=${isGemini ? 'gemini' : endpoint.includes('openrouter') ? 'openrouter' : 'groq'} messages=${JSON.stringify(parsed.messages ?? []).length} tools=${JSON.stringify(parsed.tools ?? []).length}`);
  }

  return originalFetch(url, requestInit);
};
