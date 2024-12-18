import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { XMLBuilder } from 'fast-xml-parser';

const HISTORY_FILENAME = '.next-enterprise-features-history';

interface HistoryEntry {
  t: number;                // timestamp
  op: string;              // operation type
  d?: string;              // description/details (can be multiline)
  data?: Record<string, any>; // arbitrary data associated with the operation
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

  const builder = new XMLBuilder({
    format: true,
    indentBy: '  ',
    ignoreAttributes: false,
    suppressUnpairedNode: false,
    suppressBooleanAttributes: false,
    cdataPropName: '__cdata',
  });

  const xmlObj = {
    history: {
      schema: {
        field: [
          {
            '@_name': 't',
            '@_type': 'number',
            '@_required': 'true',
            description: 'Unix timestamp in milliseconds when the operation was executed',
            format: 'ISO 8601 date string in output'
          },
          {
            '@_name': 'op',
            '@_type': 'string',
            '@_required': 'true',
            description: 'Name of the executed operation',
            format: 'Operation identifier that matches available script names'
          },
          {
            '@_name': 'd',
            '@_type': 'string',
            '@_required': 'false',
            description: 'Detailed description or context of what the operation did',
            format: 'Can contain multiline text describing the operation context'
          },
          {
            '@_name': 'data',
            '@_type': 'object',
            '@_required': 'false',
            description: 'Structured data associated with the operation',
            format: 'Key-value pairs of operation-specific data that may include nested objects or arrays'
          }
        ]
      },
      operations: {
        '@_count': Math.min(history.length, limit),
        '@_total': history.length,
        metadata: {
          description: 'List of recently executed operations, ordered from newest to oldest',
          format: 'Each operation contains timestamp, name, description, and associated data',
          limits: {
            max: limit,
            showing: Math.min(history.length, limit),
            total: history.length
          }
        },
        entries: {
          operation: history.slice(0, limit).map(h => {
            const timestamp = new Date(h.t).toISOString();
            const entry: any = {
              '@_timestamp': timestamp,
              time: {
                '@_format': 'ISO8601',
                '#text': timestamp
              },
              name: {
                '@_format': 'script-id',
                '#text': h.op
              },
              description: {
                '@_format': 'text',
                '#text': h.d || 'No description provided'
              },
              'data-entries': {
                '@_count': h.data ? Object.keys(h.data).length : 0
              }
            };

            if (h.data) {
              entry['data-entries'].data = Object.entries(h.data).map(([key, value]) => {
                const dataEntry: any = {
                  '@_key': key
                };

                if (typeof value === 'string' && value.includes('\n')) {
                  dataEntry['@_type'] = 'multiline';
                  dataEntry.__cdata = value;
                } else if (typeof value === 'object' && value !== null) {
                  dataEntry['@_type'] = 'object';
                  dataEntry.__cdata = JSON.stringify(value, null, 2);
                } else {
                  dataEntry['@_type'] = 'value';
                  dataEntry['#text'] = String(value);
                }

                return dataEntry;
              });
            } else {
              entry['data-entries'].none = '';
            }

            return entry;
          })
        }
      }
    }
  };

  return builder.build(xmlObj);
}