import * as R from "remeda"

export function estimateTokensForClaude(text: string) {
  if (R.isNullish(text) || R.isEmpty(text)) return 0;

  const regexes = {
      wordSplit: /[\s\p{P}]+/gu,
      specialChars: /[^a-zA-Z0-9\s]/g,
      camelCase: /[A-Z][a-z]+/g,
      snakeCase: /_/g,
      whitespace: /\s+/g,
      numbers: /\d+/g
  };

  const words = text.split(regexes.wordSplit).filter(w => w.length > 0);
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