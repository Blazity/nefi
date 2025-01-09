import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { xml } from './xml';

const HISTORY_FILENAME = '.nefi-history';

interface HistoryEntry {
  t: number;                // timestamp
  op: string;              // operation type
  d: string;               // description
  dt?: Record<string, any>; // arbitrary data associated with the operation
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
    writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write history:', error);
  }
}

export function clearHistory(): void {
  try {
    writeFileSync(getHistoryPath(), '[]', 'utf-8');
  } catch (error) {
    console.error('Failed to clear history:', error);
  }
}

export function getLatestOperation(): HistoryEntry | null {
  const history = readHistory();
  
  return history.length > 0 ? history[0] : null;
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

export function formatHistoryContext(limit: number = 30): string {
  const history = readHistory().slice(0, limit);
  return history
    .map(entry => {
      const date = new Date(entry.t).toISOString();
      return `[${date}] ${entry.op}${entry.d ? `: ${entry.d}` : ''}`;
    })
    .join('\n');
}

export function formatHistoryForLLM(limit: number = 30): string {
  const history = readHistory();
  if (history.length === 0) return "";

  const xmlObj = {
    history: {
      schema: {
        entry: {
          '@_required': 'true',
          '@_type': 'array',
          fields: {
            t: {
              '@_type': 'number',
              '@_description': 'timestamp in milliseconds',
              '@_required': 'true'
            },
            op: {
              '@_type': 'string',
              '@_description': 'operation type',
              '@_required': 'true'
            },
            d: {
              '@_type': 'string',
              '@_description': 'description',
              '@_required': 'true'
            },
            dt: {
              '@_type': 'object',
              '@_description': 'arbitrary data associated with the operation',
              '@_required': 'false'
            }
          }
        }
      },
      entries: history.map(entry => {
        const result: Record<string, any> = {
          t: {
            '@_timestamp': new Date(entry.t).toISOString(),
            '#text': entry.t
          },
          op: {
            '#text': entry.op
          },
          d: {
            '#text': entry.d
          }
        };

        if (entry.dt) {
          result.dt = {
            data: Object.entries(entry.dt).map(([key, value]) => {
              const dataEntry: Record<string, any> = {
                '@_key': key
              };

              if (typeof value === 'string' && value.includes('\n')) {
                dataEntry['@_type'] = 'multiline';
                dataEntry['#text'] = value;
              } else if (typeof value === 'object' && value !== null) {
                dataEntry['@_type'] = 'object';
                dataEntry['#text'] = JSON.stringify(value, null, 2);
              } else {
                dataEntry['@_type'] = 'value';
                dataEntry['#text'] = String(value);
              }

              return dataEntry;
            })
          };
        }

        return result;
      })
    }
  };

  return xml.build(xmlObj);
}