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

export function formatHistoryContext(limit: number = 30): string {
  const history = readHistory();
  if (history.length === 0) return "";

  return `\n\nRecent operations:\n${history
    .slice(0, limit)
    .map((h) => `- ${h.op}${h.p ? ` (${h.p.join(", ")})` : ""}`)
    .join("\n")}`;
}

export function formatHistoryForLLM(limit: number = 30): string {
  const history = readHistory();
  if (history.length === 0) return "";

  return `
<history>
  <schema>
    <field name="t" type="number" required="true">
      <description>Unix timestamp in milliseconds when the operation was executed</description>
      <format>ISO 8601 date string in output</format>
    </field>
    <field name="op" type="string" required="true">
      <description>Name of the executed operation</description>
      <format>Operation identifier that matches available script names</format>
    </field>
    <field name="d" type="string" required="false">
      <description>Detailed description of what the operation did</description>
    </field>
    <field name="p" type="array" required="false">
      <description>List of parameters or arguments used in the operation</description>
      <format>Each parameter is wrapped in a param tag</format>
    </field>
  </schema>

  <operations count="${Math.min(history.length, limit)}" total="${history.length}">
    <metadata>
      <description>List of recently executed operations, ordered from newest to oldest</description>
      <format>Each operation contains timestamp, name, description, and parameters</format>
      <limits>
        <max>${limit}</max>
        <showing>${Math.min(history.length, limit)}</showing>
        <total>${history.length}</total>
      </limits>
    </metadata>
    <entries>
    ${history
      .slice(0, limit)
      .map(h => {
        const timestamp = new Date(h.t).toISOString();
        return `<operation timestamp="${timestamp}">
      <time format="ISO8601">${timestamp}</time>
      <name format="script-id">${h.op}</name>
      <description format="text">${h.d || 'No description provided'}</description>
      <parameters count="${h.p?.length || 0}">
        ${h.p?.length ? h.p.map(param => `<param format="text">${param}</param>`).join('\n        ') : '<none />'}
      </parameters>
    </operation>`; // Added semicolon here
      })
      .join('\n    ')}
    </entries>
  </operations>
</history>`;
}