import sanitizeHtml from 'sanitize-html';
import he from 'he';
import { tokenizeString } from './dynamicLinking.js';

const TEMPLATE_REGEX = /{{\s*([^}]+)\s*}}/g;

export function parseTemplateMatchTokens(match) {
  const decoded = he.decode(
    sanitizeHtml(match[1], {
      allowedTags: [],
      allowedAttributes: {},
    }),
  );
  const [label, targetBoardName, targetName] = tokenizeString(decoded)
    .map((token) => token.replace(/\s+/g, ' ').trim());
  return {
    label,
    targetBoardName,
    targetName,
    originalMatch: match[0],
  };
}

export function collectLinksFromTemplateText(text) {
  if (typeof text !== 'string' || !text) return [];
  const links = [];
  let match;
  const regex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags);
  while ((match = regex.exec(text)) !== null) {
    links.push(parseTemplateMatchTokens(match));
  }
  return links;
}
