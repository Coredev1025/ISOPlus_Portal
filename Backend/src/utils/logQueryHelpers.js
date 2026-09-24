/**
 * The Mongo filter behind the Application Logs viewer.
 *
 * Pure and separate from the route so the handler stays under the cognitive
 * complexity gate, and so the filter can be tested without a request: the
 * route's job is HTTP, this one's is "which logs did they ask for".
 *
 * Readers: routes/log.js.
 */
import { toQueryString } from './securityHelpers.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A filter value an operator actually supplied, or null. */
function supplied(raw) {
  const value = toQueryString(raw);
  return value && value !== 'all' ? value : null;
}

/**
 * The fields `search` looks in.
 *
 * KAN-267 added the last three. A run is identified by its workspace, board
 * and period, and those live in metadata — so pasting an id into the search
 * box, which is the first thing an operator does, previously matched nothing
 * at all. The one log line that explains a silent automation run was
 * unreachable among tens of thousands of others.
 */
const SEARCHABLE_FIELDS = [
  'message',
  'metadata.source',
  'metadata.workspaceId',
  'metadata.boardId',
  'metadata.periodKey',
];

/**
 * `level` matches whole and case-insensitively; `source` is a contains match,
 * as it always was. `workspaceId` and `boardId` are EXACT: an id is a whole
 * value, and a regex would make '55515' also return '155515'.
 */
export function buildLogQuery({ level, source, workspaceId, boardId, search } = {}) {
  const query = {};

  const levelValue = supplied(level);
  if (levelValue) {
    query.level = { $regex: new RegExp(`^${escapeRegex(levelValue)}$`, 'i') };
  }

  const sourceValue = supplied(source);
  if (sourceValue) {
    query['metadata.source'] = { $regex: new RegExp(escapeRegex(sourceValue), 'i') };
  }

  const workspaceValue = supplied(workspaceId);
  if (workspaceValue) query['metadata.workspaceId'] = workspaceValue;

  const boardValue = supplied(boardId);
  if (boardValue) query['metadata.boardId'] = boardValue;

  const searchValue = toQueryString(search);
  if (searchValue) {
    const regex = new RegExp(escapeRegex(searchValue), 'i');
    query.$or = SEARCHABLE_FIELDS.map((field) => ({ [field]: regex }));
  }

  return query;
}
