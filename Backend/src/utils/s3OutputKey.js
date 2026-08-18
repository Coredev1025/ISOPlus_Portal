import { OUTPUT_PREFIX } from '../constants/storage.js';

/**
 * One path segment, with anything that could add a level or climb out of the
 * folder removed. Names carry participant and item text straight from ISO+, so
 * they are untrusted: a name of `../../other-workspace/steal.pdf` must land in
 * this board's folder, not another one's.
 */
function segment(value, field) {
  const text = String(value ?? '').replace(/[/\\]+/g, '-').replace(/\.{2,}/g, '.').trim();
  if (!text || text === '.') {
    throw new Error(`S3 output key: ${field} is required`);
  }
  return text;
}

/**
 * The key a generated document is stored under:
 * `output/<workspaceId>/<boardId>/<type>/<name>`.
 *
 * One builder rather than the same template string at eight call sites, so the
 * layout the buckets are organised by is stated once and cannot drift a folder
 * at a time.
 */
export function buildOutputKey({ workspaceId, boardId, type, name }) {
  return [
    OUTPUT_PREFIX,
    segment(workspaceId, 'workspaceId'),
    segment(boardId, 'boardId'),
    segment(type, 'type'),
    segment(name, 'name'),
  ].join('/');
}
