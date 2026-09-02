import { promises as fs } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.cwd(), 'data');
const memoryPath = path.join(dataDir, 'trading-memory.json');

export type MemoryEntry = {
  timestamp: string;
  action: string;
  toolCalls: string[];
  summary: string;
  forecast?: string;
};

export async function webResearch(query: string, maxResults = 6): Promise<unknown> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      enabled: false,
      error: 'Web research is not configured. Set TAVILY_API_KEY to enable live web search.',
      query,
    };
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: process.env.TAVILY_SEARCH_DEPTH ?? 'advanced',
      topic: 'news',
      max_results: Math.min(Math.max(maxResults, 1), 10),
      include_answer: true,
      include_raw_content: false,
    }),
  });

  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Web research failed (${response.status}): ${JSON.stringify(data)}`);

  return {
    query,
    answer: data.answer ?? null,
    results: Array.isArray(data.results)
      ? data.results.map((item: any) => ({
          title: item.title,
          url: item.url,
          published_date: item.published_date ?? null,
          content: String(item.content ?? '').slice(0, 3500),
        }))
      : [],
  };
}

export async function loadTradingMemory(limit = 20): Promise<MemoryEntry[]> {
  try {
    const raw = await fs.readFile(memoryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-limit) : [];
  } catch {
    return [];
  }
}

export async function saveTradingMemory(entry: MemoryEntry): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const existing = await loadTradingMemory(500);
  existing.push(entry);
  await fs.writeFile(memoryPath, JSON.stringify(existing.slice(-500), null, 2) + '\n', 'utf8');
}
