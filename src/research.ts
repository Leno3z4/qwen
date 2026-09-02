import { promises as fs } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const dataDir = path.resolve(process.cwd(), 'data');
const memoryPath = path.join(dataDir, 'trading-memory.json');
let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

export type MemoryEntry = {
  timestamp: string;
  action: string;
  toolCalls: string[];
  summary: string;
  forecast?: string;
  outcome?: string;
};

function getPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  return pool;
}

async function ensureSchema(): Promise<void> {
  const db = getPool();
  if (!db) return;
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS trading_memory (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        action TEXT NOT NULL,
        tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
        summary TEXT NOT NULL,
        forecast TEXT,
        outcome TEXT
      )
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

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

async function loadTradingMemoryFromFile(limit: number): Promise<MemoryEntry[]> {
  try {
    const raw = await fs.readFile(memoryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-limit) : [];
  } catch {
    return [];
  }
}

export async function loadTradingMemory(limit = 20): Promise<MemoryEntry[]> {
  const db = getPool();
  if (!db) return loadTradingMemoryFromFile(limit);
  await ensureSchema();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const result = await db.query(
    `SELECT timestamp, action, tool_calls AS "toolCalls", summary, forecast, outcome
     FROM trading_memory ORDER BY id DESC LIMIT $1`,
    [safeLimit],
  );
  return result.rows.reverse().map((row) => ({
    timestamp: new Date(row.timestamp).toISOString(),
    action: row.action,
    toolCalls: Array.isArray(row.toolCalls) ? row.toolCalls : [],
    summary: row.summary,
    forecast: row.forecast ?? undefined,
    outcome: row.outcome ?? undefined,
  }));
}

export async function saveTradingMemory(entry: MemoryEntry): Promise<void> {
  const db = getPool();
  if (!db) {
    await fs.mkdir(dataDir, { recursive: true });
    const existing = await loadTradingMemoryFromFile(500);
    existing.push(entry);
    await fs.writeFile(memoryPath, JSON.stringify(existing.slice(-500), null, 2) + '\n', 'utf8');
    return;
  }
  await ensureSchema();
  await db.query(
    `INSERT INTO trading_memory (timestamp, action, tool_calls, summary, forecast, outcome)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [new Date(entry.timestamp), entry.action, JSON.stringify(entry.toolCalls), entry.summary, entry.forecast ?? null, entry.outcome ?? null],
  );
}
