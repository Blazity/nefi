import * as R from "remeda";

export function estimateTokensForClaude(text: string) {
  if (R.isNullish(text) || R.isEmpty(text)) return 0;

  const regexes = {
    wordSplit: /[\s\p{P}]+/gu,
    specialChars: /[^a-zA-Z0-9\s]/g,
    camelCase: /[A-Z][a-z]+/g,
    snakeCase: /_/g,
    whitespace: /\s+/g,
    numbers: /\d+/g,
  };

  const words = text.split(regexes.wordSplit).filter((w) => w.length > 0);
  const specialChars = text.match(regexes.specialChars) || [];
  const subwordBreaks = words.reduce((count, word) => {
    const caseBreaks = (word.match(regexes.camelCase) || []).length;
    const snakeBreaks = (word.match(regexes.snakeCase) || []).length;
    return count + caseBreaks + snakeBreaks;
  }, 0);
  const whitespaceCount = (text.match(regexes.whitespace) || []).length;
  const numbers = text.match(regexes.numbers) || [];

  return Math.ceil(
    words.length * 1.3 +
      specialChars.length +
      subwordBreaks +
      whitespaceCount * 0.3 +
      numbers.length * 0.5
  );
}

interface BalanceOptions {
  maxWidth?: number;
  minWidth?: number;
  preserveWords?: boolean;
}

export function balanceText(
  text: string,
  options: BalanceOptions = {}
): string {
  const defaultOptions: Required<BalanceOptions> = {
    maxWidth: process.stdout.columns || 80,
    minWidth: 40,
    preserveWords: true,
  };

  const opts = { ...defaultOptions, ...options };
  const normalizedText = text.replace(/\s+/g, " ").trim();

  if (normalizedText.length <= opts.maxWidth) {
    return normalizedText;
  }

  const words = opts.preserveWords
    ? normalizedText.split(" ")
    : normalizedText.split("");
  const initialLines = splitIntoLines(words, opts.maxWidth);
  return balanceLines(initialLines, opts);
}

function splitIntoLines(words: string[], maxWidth: number): string[] {
  const lines: string[] = [];
  let currentLine: string[] = [];
  let currentLength = 0;

  for (const word of words) {
    const wordLength = word.length + (currentLength > 0 ? 1 : 0);

    if (currentLength + wordLength <= maxWidth) {
      currentLine.push(word);
      currentLength += wordLength;
    } else {
      if (currentLine.length > 0) {
        lines.push(currentLine.join(" "));
      }
      currentLine = [word];
      currentLength = word.length;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine.join(" "));
  }

  return lines;
}

function balanceLines(lines: string[], opts: Required<BalanceOptions>): string {
  if (lines.length <= 1) return lines.join("\n");

  const totalLength = lines.reduce((sum, line) => sum + line.length, 0);
  const targetLength = Math.floor(totalLength / lines.length);
  const words = lines.join(" ").split(" ");

  return redistributeWords(words, targetLength);
}

function redistributeWords(words: string[], targetLength: number): string {
  const balanced: string[] = [];
  let currentLine: string[] = [];
  let currentLength = 0;

  for (const word of words) {
    const wordLength = word.length + (currentLength > 0 ? 1 : 0);
    const nextLength = currentLength + wordLength;

    if (nextLength <= targetLength || currentLine.length === 0) {
      currentLine.push(word);
      currentLength = nextLength;
    } else {
      balanced.push(currentLine.join(" "));
      currentLine = [word];
      currentLength = word.length;
    }
  }

  if (currentLine.length > 0) {
    balanced.push(currentLine.join(" "));
  }

  return balanced.join("\n");
}
