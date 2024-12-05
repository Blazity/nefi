import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const HISTORY_FILENAME = '.next-enterprise-features-history';

interface HistoryEntry {
  t: number;
  op: string;
  d?: string;
  p?: string[];
}

function getHistoryPath(): string {
  return join(process.cwd(), HISTORY_FILENAME);
}

export function ensureHistoryExists(): void {
  const historyPath = getHistoryPath();
  if (!existsSync(historyPath)) {
    writeFileSync(historyPath, '[]', 'utf-8');
  }
}

export function readHistory(): HistoryEntry[] {
  try {
    ensureHistoryExists();
    const content = readFileSync(getHistoryPath(), 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to read history:', error);
    return [];
  }
}

export function writeHistory(entry: Omit<HistoryEntry, 't'>): void {
  try {
    ensureHistoryExists();
    const history = readHistory();
    const newEntry: HistoryEntry = {
      t: Date.now(),
      ...entry
    };
    history.unshift(newEntry);
    writeFileSync(getHistoryPath(), JSON.stringify(history), 'utf-8');
  } catch (error) {
    console.error('Failed to write history:', error);
  }
}

export function clearHistory(): void {
  try {
    ensureHistoryExists();
    writeFileSync(getHistoryPath(), '[]', 'utf-8');
  } catch (error) {
    console.error('Failed to clear history:', error);
  }
}

export function getLatestOperation(): HistoryEntry | null {
  const history = readHistory();
  return history[0] || null;
}

export function searchHistory(query: { op?: string; from?: number; to?: number }): HistoryEntry[] {
  const history = readHistory();
  return history.filter(entry => {
    if (query.op && entry.op !== query.op) return false;
    if (query.from && entry.t < query.from) return false;
    if (query.to && entry.t > query.to) return false;
    return true;
  });
}