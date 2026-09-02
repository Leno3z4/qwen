import { promises as fs } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.cwd(), 'data');
const strategyPath = path.join(dataDir, 'strategy.md');

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

export async function loadStrategy(): Promise<string> {
  try {
    return await fs.readFile(strategyPath, 'utf8');
  } catch {
    return defaultStrategy;
  }
}

export async function saveStrategy(strategy: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(strategyPath, strategy.trim() + '\n', 'utf8');
}
