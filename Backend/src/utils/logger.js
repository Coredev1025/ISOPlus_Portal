import winston from "winston";
import * as Sentry from "@sentry/node";
const { combine, timestamp, printf, colorize, json } = winston.format;
import "winston-daily-rotate-file";
import "winston-mongodb";
import dotenv from 'dotenv';
import util from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

try {
  const logsDir = path.resolve(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
} catch {
}

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue'
};

winston.addColors(colors);

const consoleFormat = printf(({ level, message, timestamp, source, ip, email, ...metadata }) => {
  let metaString = '';
  if (Object.keys(metadata).length) {
    try {
      metaString = util.inspect(metadata, { depth: 3, colors: false });
    } catch (e) {
      metaString = '[Unable to stringify metadata: ' + e.message + ']';
    }
  }
  return `${timestamp}===> [${level}]: ${ip || 'N/A'}==>${email || 'N/A'}=> ${source || 'App'}: ${message} ${metaString}`;
});

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/business-dashboard';

// Cache to store recent log entries to prevent duplicates
const logCache = new Map();
const CACHE_TTL = parseInt(process.env.LOG_DEDUP_TTL) || 5000; // 5 seconds TTL for duplicate detection
const ENABLE_DEDUP = process.env.ENABLE_LOG_DEDUP !== 'false'; // Enable by default, can be disabled with env var

// Memory optimization settings for MongoDB storage
const MAX_STRING_LENGTH = parseInt(process.env.LOG_MAX_STRING_LENGTH) || 500; // Max length for strings (stack traces, messages)
const MAX_OBJECT_DEPTH = parseInt(process.env.LOG_MAX_OBJECT_DEPTH) || 3; // Max depth for nested objects
const MAX_ARRAY_LENGTH = parseInt(process.env.LOG_MAX_ARRAY_LENGTH) || 10; // Max array length
const MAX_METADATA_SIZE = parseInt(process.env.LOG_MAX_METADATA_SIZE) || 50000; // Max size in bytes for metadata (50KB)
const MAX_STACK_LENGTH = parseInt(process.env.LOG_MAX_STACK_LENGTH) || 1000; // Max length for stack traces

// Fields to exclude from MongoDB storage (to save memory)
const EXCLUDED_FIELDS = new Set([
  'data', // Often contains large objects
  'result', // Can contain large result sets
  'response', // Can contain large API responses
  'request', // Can contain large request payloads
  'body', // Request body can be large
  'payload', // Can be large
  'items', // Can be large arrays
  'files', // File data is too large
  'buffer', // Binary data
  'stream', // Stream objects
  'socket', // Socket objects
  'req', // Full request object
  'res', // Full response object
]);

// Function to generate a unique key for log deduplication
function generateLogKey(level, source, message, meta, context) {
  const ip = context?.ip || 'N/A';
  const email = context?.email || 'N/A';
  
  // Create a hash of the log content for deduplication
  const contentHash = crypto.createHash('md5').update(
    JSON.stringify({ level, source, message, meta, ip, email })
  ).digest('hex');
  
  return `${level}-${source}-${contentHash}`;
}

// Function to check if log entry is a duplicate
function isDuplicateLog(level, source, message, meta, context) {
  const key = generateLogKey(level, source, message, meta, context);
  const now = Date.now();
  
  if (logCache.has(key)) {
    const entry = logCache.get(key);
    // If the entry is within TTL, it's a duplicate
    if (now - entry.timestamp < CACHE_TTL) {
      return true;
    }
  }
  
  // Store the entry with current timestamp
  logCache.set(key, { timestamp: now });
  
  // Clean up old entries periodically
  if (logCache.size > 1000) {
    for (const [cacheKey, entry] of logCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        logCache.delete(cacheKey);
      }
    }
  }
  
  return false;
}

function isExpressReqLike(obj) {
  return !!obj &&
    typeof obj === 'object' &&
    typeof obj.method === 'string' &&
    (typeof obj.originalUrl === 'string' || typeof obj.url === 'string') &&
    (typeof obj.get === 'function' || typeof obj.headers === 'object');
}

function normalizeErrorMeta(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack,
    };
  }
  if (typeof err === 'object') {
    const maybeMessage = err.message ? String(err.message) : undefined;
    const maybeStack = err.stack ? String(err.stack) : undefined;
    const maybeName = err.name ? String(err.name) : undefined;
    return {
      errorName: maybeName,
      errorMessage: maybeMessage,
      stack: maybeStack,
      ...err,
    };
  }
  return { errorMessage: String(err) };
}

/**
 * Truncate string to max length, adding ellipsis if truncated
 */
function truncateString(str, maxLength) {
  if (typeof str !== 'string') return str;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Get approximate size of an object in bytes
 */
function getObjectSize(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Sanitize metadata to reduce memory usage before storing in MongoDB
 * This function filters out large objects, truncates long strings, and limits depth
 */
function sanitizeMetadataForStorage(obj, depth = 0, path = '') {
  // Limit depth to prevent deep recursion
  if (depth > MAX_OBJECT_DEPTH) {
    return '[Max depth reached]';
  }

  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Preserve Error details (message/stack) even when nested
  if (obj instanceof Error) {
    return sanitizeMetadataForStorage(normalizeErrorMeta(obj), depth + 1, `${path}.error`);
  }

  // Handle primitives
  if (typeof obj !== 'object') {
    if (typeof obj === 'string') {
      // Special handling for stack traces
      if (path.includes('stack') || path.includes('Stack')) {
        return truncateString(obj, MAX_STACK_LENGTH);
      }
      return truncateString(obj, MAX_STRING_LENGTH);
    }
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_LENGTH) {
      const truncated = obj.slice(0, MAX_ARRAY_LENGTH);
      return [
        ...truncated.map((item, idx) => 
          sanitizeMetadataForStorage(item, depth + 1, `${path}[${idx}]`)
        ),
        `[${obj.length - MAX_ARRAY_LENGTH} more items...]`
      ];
    }
    return obj.map((item, idx) => 
      sanitizeMetadataForStorage(item, depth + 1, `${path}[${idx}]`)
    );
  }

  // Handle objects
  const sanitized = {};
  let currentSize = 0;

  for (const [key, value] of Object.entries(obj)) {
    // Skip excluded fields that are known to be large
    if (EXCLUDED_FIELDS.has(key.toLowerCase())) {
      sanitized[key] = '[Excluded - too large]';
      continue;
    }

    // Skip functions, buffers, streams, and other non-serializable objects
    if (typeof value === 'function' || 
        value instanceof Buffer || 
        (value && typeof value === 'object' && value.constructor && 
         (value.constructor.name === 'Stream' || value.constructor.name === 'Socket'))) {
      sanitized[key] = `[${value.constructor?.name || 'Non-serializable'}]`;
      continue;
    }

    // Recursively sanitize nested objects
    const sanitizedValue = value instanceof Error
      ? sanitizeMetadataForStorage(normalizeErrorMeta(value), depth + 1, `${path}.${key}`)
      : sanitizeMetadataForStorage(value, depth + 1, `${path}.${key}`);
    
    // Estimate size of this field
    const fieldSize = getObjectSize({ [key]: sanitizedValue });
    
    // If adding this field would exceed max size, stop adding more fields
    if (currentSize + fieldSize > MAX_METADATA_SIZE) {
      sanitized['_truncated'] = '[Metadata size limit reached]';
      break;
    }

    sanitized[key] = sanitizedValue;
    currentSize += fieldSize;
  }

  return sanitized;
}

// Custom format for MongoDB that sanitizes metadata
const mongoSanitizeFormat = winston.format((info) => {
  // Sanitize metadata before storing in MongoDB
  if (info.metadata) {
    info.metadata = sanitizeMetadataForStorage(info.metadata);
  }
  return info;
});

const dropHttpLifecycleForPersistence = winston.format((info) => {
  const source = info?.metadata?.source ?? info?.source;
  const msg = info?.message;
  if (source === 'HTTP' && (msg === 'Request start' || msg === 'Request end')) {
    return false;
  }
  return info;
});

const logger = winston.createLogger({
  levels,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY/MM/DD, HH:mm:ss' }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      level: 'debug', // Set to the lowest level to log all levels
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'YYYY/MM/DD, HH:mm:ss' }),
        consoleFormat
      )
    }),
    new winston.transports.DailyRotateFile({
      level: 'debug', // Set to the lowest level to log all levels
      filename: 'logs/application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(
        dropHttpLifecycleForPersistence(),
        winston.format.timestamp({ format: 'YYYY/MM/DD, HH:mm:ss' }),
        winston.format.json()
      )
    }),
    new winston.transports.MongoDB({
      level: 'debug', // Set to the lowest level to log all levels
      db: MONGODB_URI,
      options: {
        useUnifiedTopology: true
      },
      collection: 'logs',
      format: winston.format.combine(
        dropHttpLifecycleForPersistence(),
        mongoSanitizeFormat(),
        json()
      ),
      tryReconnect: true,
      metaKey: 'metadata',
      // Add options to reduce memory usage
      capped: false, // Set to true if you want capped collection (limits size)
      expireAfterSeconds: parseInt(process.env.LOG_TTL_DAYS) ? parseInt(process.env.LOG_TTL_DAYS) * 24 * 60 * 60 : undefined // Auto-delete old logs
    })
  ]
});

export function extractContextFromReq(req) {
  if (!req || typeof req !== 'object') return {};

  const headers = req.headers || {};
  const userAction =
    headers?.['x-user-action'] ||
    headers?.['x-app-action'] ||
    headers?.['x-audit-action'] ||
    headers?.['X-User-Action'] ||
    headers?.['X-App-Action'] ||
    headers?.['X-Audit-Action'];

  return {
    ip: req.ip?.split(':').pop(),
    email: req.user?.email,
    userId: req.user?.userId || req.user?.id,
    userRole: req.user?.role,
    method: req.method,
    url: req.originalUrl || req.url,
    userAgent: req.get ? req.get('User-Agent') : headers['user-agent'],
    referer: req.get ? req.get('Referer') : headers['referer'],
    workspaceId: req.params?.workspaceId || req.body?.workspaceId || req.query?.workspaceId,
    boardId: req.params?.boardId || req.body?.boardId || req.query?.boardId,
    requestId: headers?.['x-request-id'] || headers?.['X-Request-Id'] || req.requestId,
    userAction: userAction ? String(userAction).trim() : undefined
  };
}

function normalizeContext(context) {
  if (!context) return {};
  if (isExpressReqLike(context)) return extractContextFromReq(context);
  return context;
}

/**
 * Main logging function
 * @param {string} level - Log level (error, warn, info, debug)
 * @param {string} source - Source of the log (e.g., 'Sync-Service', 'Auth-Route')
 * @param {string} message - Log message
 * @param {object} meta - Additional metadata
 * @param {object} context - Context object containing ip, email, userId, userRole, request info, etc.
 */
const log = (level, source, message, meta = {}, context = null) => {
  const ctx = normalizeContext(context);
  // Extract context data with fallbacks
  const ip = ctx.ip || 'N/A';
  const email = ctx.email || 'N/A';
  const userId = ctx.userId || 'N/A';
  const userRole = ctx.userRole || 'N/A';
  
  // Check if this is a duplicate log entry (only if deduplication is enabled)
  if (ENABLE_DEDUP && isDuplicateLog(level, source, message, meta, ctx)) {
    return; // Skip logging if it's a duplicate
  }
  
  let metaData = meta;
  if(typeof metaData === 'string') {
    try{
      meta = JSON.parse(metaData);
    } catch {
      meta = {
        data: metaData
      }
    }
  }

  if (meta instanceof Error) {
    meta = normalizeErrorMeta(meta);
  }

  // Filter out large/unnecessary fields from meta before processing
  const filteredMeta = {};
  for (const [key, value] of Object.entries(meta || {})) {
    // Skip excluded fields
    if (EXCLUDED_FIELDS.has(key.toLowerCase())) {
      continue;
    }
    
    // Skip very large objects/arrays
    if (typeof value === 'object' && value !== null) {
      const size = getObjectSize(value);
      if (size > MAX_METADATA_SIZE / 2) {
        // If a single field is too large, replace with summary
        if (Array.isArray(value)) {
          filteredMeta[key] = `[Array with ${value.length} items - too large to store]`;
        } else {
          filteredMeta[key] = '[Object too large to store]';
        }
        continue;
      }
    }
    
    filteredMeta[key] = value;
  }

  // Enhanced metadata structure for better diagnostics (only essential fields)
  // Note: Don't include 'message' or 'level' here - winston stores these at the top level
  // Don't include 'timestamp' either - winston adds its own timestamp
  const enhancedMeta = {
    source,
    ip,
    email,
    userId,
    userRole,
    ...filteredMeta,
    // Add request context if available (only essential fields)
    requestContext: ctx.method ? {
      method: ctx.method,
      url: truncateString(ctx.url || '', 200), // Truncate long URLs
      workspaceId: ctx.workspaceId || meta.workspaceId,
      boardId: ctx.boardId || meta.boardId,
      requestId: ctx.requestId,
      userAction: ctx.userAction
      // Exclude userAgent and referer to save space (can be added back if needed)
    } : {}
  };

  // Sanitize error messages and stack traces in metadata
  if (enhancedMeta.error && typeof enhancedMeta.error === 'string') {
    enhancedMeta.error = truncateString(enhancedMeta.error, MAX_STRING_LENGTH);
  }
  if (enhancedMeta.stack && typeof enhancedMeta.stack === 'string') {
    enhancedMeta.stack = truncateString(enhancedMeta.stack, MAX_STACK_LENGTH);
  }
  if (enhancedMeta.stackTrace && typeof enhancedMeta.stackTrace === 'string') {
    enhancedMeta.stackTrace = truncateString(enhancedMeta.stackTrace, MAX_STACK_LENGTH);
  }

  logger.log(level, message, enhancedMeta);
};

export const error = (source, message, meta = {}, context = null) => {
  if (meta instanceof Error) return log('error', source, message, normalizeErrorMeta(meta), context);
  return log('error', source, message, meta, context);
};
export const warn = (source, message, meta = {}, context = null) => log('warn', source, message, meta, context);
export const info = (source, message, meta = {}, context = null) => log('info', source, message, meta, context);
export const debug = (source, message, meta = {}, context = null) => log('debug', source, message, meta, context);

// Enhanced error logging for attribute-related issues
export const logAttributeError = (source, message, attributeId, metadata, context = null) => {
  const errorContext = {
    attributeId,
    errorType: 'ATTRIBUTE_RECOGNITION_ERROR',
    ...metadata,
    diagnosticInfo: {
      attributeIdValid: attributeId && typeof attributeId === 'string' && attributeId.length > 0,
      attributeIdFormat: attributeId ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attributeId) : false,
      timestamp: new Date().toISOString()
    }
  };
  error(source, message, errorContext, context);
};

// Enhanced error logging for API-related issues
export const logApiError = (source, message, apiContext, context = null) => {
  const errorContext = {
    errorType: 'API_ERROR',
    apiContext,
    diagnosticInfo: {
      hasStatusCode: !!apiContext.statusCode,
      hasResponseData: !!apiContext.responseData,
      hasRequestPayload: !!apiContext.requestPayload,
      timestamp: new Date().toISOString()
    }
  };
  error(source, message, errorContext, context);
};

/**
 * Deep diagnostic logging for login / authentication failures.
 *
 * Captures the exact stage a login broke at plus structured diagnostic flags,
 * so failures can be triaged from the Application Logs viewer without needing
 * to reproduce. Tagged with errorType 'LOGIN_FAILURE' for filtering.
 *
 * @param {string} source - Log source (e.g. 'Auth-Service').
 * @param {string} message - Human-readable summary.
 * @param {object} diagnostics - Diagnostic fields:
 *   @param {string} diagnostics.method - Login method ('isoplus-oauth' | 'support-admin' | 'oauth-exchange' | 'oauth-login').
 *   @param {string} diagnostics.stage - Where it failed (e.g. 'token_exchange', 'profile_fetch', 'ticket_redeem', 'workspace_fetch', 'account_disabled', 'invalid_credentials').
 *   @param {string} [diagnostics.reason] - Specific reason (defaults to message).
 *   @param {number} [diagnostics.httpStatus] - HTTP status we returned to the client.
 *   @param {number} [diagnostics.upstreamStatus] - HTTP status from an upstream call (ISO+ token/profile/workspace).
 *   @param {any}    [diagnostics.upstreamError] - Upstream error body/message (truncated/stringified).
 *   @param {string} [diagnostics.level] - winston level to emit ('warn' default, 'error' for system/upstream faults).
 * @param {object} context - Express req or context object.
 */
export const logLoginFailure = (source, message, diagnostics = {}, context = null) => {
  const {
    method,
    stage,
    reason,
    httpStatus,
    upstreamStatus,
    upstreamError,
    level = 'warn',
    ...rest
  } = diagnostics;

  let upstreamErrorStr;
  if (upstreamError !== undefined && upstreamError !== null) {
    upstreamErrorStr = typeof upstreamError === 'string'
      ? truncateString(upstreamError, MAX_STRING_LENGTH)
      : truncateString(JSON.stringify(upstreamError), MAX_STRING_LENGTH);
  }

  const errorContext = {
    errorType: 'LOGIN_FAILURE',
    loginMethod: method,
    loginStage: stage,
    failureReason: reason || message,
    httpStatus,
    upstreamStatus,
    upstreamError: upstreamErrorStr,
    ...rest,
    diagnosticInfo: {
      method: method || null,
      stage: stage || null,
      reason: reason || message,
      httpStatus: httpStatus ?? null,
      upstreamStatus: upstreamStatus ?? null,
      timestamp: new Date().toISOString(),
    },
  };

  forwardLoginLogToSentry(level, message, errorContext, context);
  return log(level, source, message, errorContext, context);
};

export const logLoginSuccess = (source, message, diagnostics = {}, context = null) => {
  const successContext = {
    eventType: 'LOGIN_SUCCESS',
    loginMethod: diagnostics.method,
    ...diagnostics,
  };

  forwardLoginLogToSentry('info', message, successContext, context);
  return log('info', source, message, successContext, context);
};

const ISOPLUS_LOGIN_METHODS = new Set(['isoplus-oauth', 'oauth-exchange', 'oauth-login']);

const SENTRY_DIAGNOSTIC_SKIP = new Set([
  'errorType', 'eventType', 'loginMethod', 'method', 'loginStage', 'stage',
  'failureReason', 'reason', 'httpStatus', 'upstreamStatus', 'email',
  'requestId', 'diagnosticInfo', 'err', 'error', 'stack', 'stackTrace',
]);

function coerceSentryAttribute(value) {
  const t = typeof value;
  if (t === 'string') return truncateString(value, MAX_STRING_LENGTH);
  if (t === 'number' || t === 'boolean') return value;
  try {
    return truncateString(JSON.stringify(value), MAX_STRING_LENGTH);
  } catch {
    return String(value);
  }
}

function forwardLoginLogToSentry(level, message, diagnostics = {}, context = null) {
  if (!Sentry.isInitialized?.()) return;

  const method = diagnostics.loginMethod ?? diagnostics.method;
  if (!ISOPLUS_LOGIN_METHODS.has(method)) return;

  const ctx = normalizeContext(context);
  const attributes = {
    feature: 'isoplus-login',
    loginMethod: method ?? null,
    loginStage: diagnostics.loginStage ?? diagnostics.stage ?? null,
    failureReason: diagnostics.failureReason ?? diagnostics.reason ?? null,
    httpStatus: diagnostics.httpStatus ?? null,
    upstreamStatus: diagnostics.upstreamStatus ?? null,
    ip: ctx.ip || undefined,
    email: ctx.email || diagnostics.email || undefined,
    requestId: ctx.requestId || diagnostics.requestId || undefined,
  };

  for (const [key, value] of Object.entries(diagnostics)) {
    if (SENTRY_DIAGNOSTIC_SKIP.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (attributes[key] !== undefined) continue;
    attributes[key] = coerceSentryAttribute(value);
  }

  const sentryLevel = level === 'fatal' ? 'error' : level;
  const emit = Sentry.logger?.[sentryLevel] ?? Sentry.logger?.info;
  emit?.(message, attributes);
}

// Context-aware logging for operation flow tracking
export const logOperationStart = (source, operation, metadata, context = {}) => {
  const ctx = normalizeContext(context);
  const operationContext = {
    operationType: 'OPERATION_START',
    operation,
    ...metadata,
    timestamp: new Date().toISOString(),
    requestId: ctx.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  info(source, `Starting operation: ${operation}`, operationContext, context);
};

export const logOperationEnd = (source, operation, metadata, context = {}, success = true) => {
  const ctx = normalizeContext(context);
  const operationContext = {
    operationType: 'OPERATION_END',
    operation,
    ...metadata,
    success,
    timestamp: new Date().toISOString(),
    requestId: ctx.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  const level = success ? 'info' : 'warn';
  log(level, source, `Completed operation: ${operation}`, operationContext, context);
};

export default logger;
