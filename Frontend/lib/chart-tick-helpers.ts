function splitWordIntoChunks(word: string, maxCharsPerLine: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxCharsPerLine) {
    chunks.push(word.slice(i, i + maxCharsPerLine));
  }
  return chunks;
}

function addWordToWrappedLine(
  current: string,
  word: string,
  maxCharsPerLine: number,
): { emitted: string[]; current: string } {
  if (!current) {
    if (word.length <= maxCharsPerLine) return { emitted: [], current: word };
    return { emitted: splitWordIntoChunks(word, maxCharsPerLine), current: '' };
  }

  const candidate = `${current} ${word}`;
  if (candidate.length <= maxCharsPerLine) return { emitted: [], current: candidate };

  if (word.length <= maxCharsPerLine) {
    return { emitted: [current], current: word };
  }

  return { emitted: [current, ...splitWordIntoChunks(word, maxCharsPerLine)], current: '' };
}

export function wrapChartTickSegment(segment: string, maxCharsPerLine: number): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = '';

  for (const word of words) {
    const { emitted, current: nextCurrent } = addWordToWrappedLine(current, word, maxCharsPerLine);
    out.push(...emitted);
    current = nextCurrent;
  }

  if (current) out.push(current);
  return out;
}

export function wrapChartTickLabel(raw: string, maxCharsPerLine: number, maxLines: number): string[] {
  const lines = raw
    .split('\n')
    .flatMap((segment) => wrapChartTickSegment(segment.trim(), maxCharsPerLine))
    .filter(Boolean);

  if (lines.length <= maxLines) return lines;

  return [
    ...lines.slice(0, maxLines - 1),
    `${lines[maxLines - 1].slice(0, Math.max(0, maxCharsPerLine - 1))}…`,
  ];
}
