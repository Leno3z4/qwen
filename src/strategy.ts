import { promises as fs } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const dataDir = path.resolve(process.cwd(), 'data');
const strategyPath = path.join(dataDir, 'strategy.md');
let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

export const defaultStrategy = `# Trading strategy

Describe the rules Qwen should follow before it trades.

Examples:
- Markets to watch
- Preferred timeframe / cadence
- Entry conditions
- Exit conditions
- Position sizing rules
- Leverage limits
- Situations where the agent must do nothing
- How to handle existing positions and open orders
`;

const capitalDirective = `

## Engine capital directive
- Treat a small account balance as a sizing constraint, NOT an automatic reason to return NO TRADE.
- A balance at or above the actual venue minimum may be traded when Perpl's live order rules permit a valid size, margin, leverage, and liquidation-safe position.
- Do not invent an additional "safety buffer" above the venue's actual minimum. Do not convert "close to minimum" into "cannot trade" unless the live venue data explicitly says the requested order is invalid.
- When a setup is actionable, use the smallest valid order size the venue accepts and proceed within the configured leverage and risk limits.
- If an individual order is rejected for size or another venue constraint, adapt the size or choose another valid market and reassess; do not declare the entire account untradeable solely because it is small.
- Still obey every real venue constraint, account lock/freeze state, available-balance requirement, long/short permission, and configured MAX_LEVERAGE limit.
`;

function getPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  return pool;
}

async function ensureSchema(): Promise<void> {
  const db = getPool();
  if (!db) return;
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS agent_strategy (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        strategy TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function loadStrategy(): Promise<string> {
  const db = getPool();
  if (db) {
    await ensureSchema();
    const result = await db.query('SELECT strategy FROM agent_strategy WHERE id = 1');
    if (result.rows[0]?.strategy) return `${result.rows[0].strategy}${capitalDirective}`;
  }
  try {
    return `${await fs.readFile(strategyPath, 'utf8')}${capitalDirective}`;
  } catch {
    return `${defaultStrategy}${capitalDirective}`;
  }
}

export async function saveStrategy(strategy: string): Promise<void> {
  const value = strategy.trim() || defaultStrategy;
  const db = getPool();
  if (db) {
    await ensureSchema();
    await db.query(
      `INSERT INTO agent_strategy (id, strategy, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET strategy = EXCLUDED.strategy, updated_at = NOW()`,
      [value],
    );
    return;
  }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(strategyPath, value + '\n', 'utf8');
}
