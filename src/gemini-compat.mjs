const originalFetch = globalThis.fetch.bind(globalThis);
const GEMINI_OPENAI_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/openai/';

function textContent(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function normalizeMessages(messages) {
  const normalized = [];
  let toolResults = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;

    if (message.role === 'tool') {
      toolResults.push(`[Tool result: ${String(message.name ?? 'unknown')}]\n${textContent(message.content)}`);
      continue;
    }

    if (message.role === 'assistant') {
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

    if (message.role === 'system' || message.role === 'user') {
      normalized.push({ role: message.role, content: textContent(message.content) });
      continue;
    }
  }

  if (toolResults.length) {
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

function rewriteBody(rawBody) {
  if (!rawBody) return null;
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }

  body.messages = normalizeMessages(body.messages);
  body.tools = sanitizeTools(body.tools);
  delete body.parallel_tool_calls;
  delete body.tool_choice;
  body.reasoning_effort = 'low';
  return JSON.stringify(body);
}

globalThis.fetch = async function patchedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!url.startsWith(GEMINI_OPENAI_PREFIX)) {
    return originalFetch(input, init);
  }

  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const originalBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  const rewrittenBody = rewriteBody(typeof originalBody === 'string' ? originalBody : null);

  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has('x-goog-api-client')) headers.set('x-goog-api-client', 'qwen-autonomous-agent/0.3.1');

  const requestInit = { ...init, method, headers, body: rewrittenBody ?? originalBody };
  console.log(`[model] Gemini compatibility shim applied: messages=${JSON.stringify(JSON.parse(rewrittenBody ?? originalBody ?? '{}').messages ?? []).length} tools=${JSON.stringify(JSON.parse(rewrittenBody ?? originalBody ?? '{}').tools ?? []).length}`);

  return originalFetch(url, requestInit);
};
