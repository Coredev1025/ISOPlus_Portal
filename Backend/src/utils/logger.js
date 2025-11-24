import winston from "winston";
const { combine, timestamp, printf, colorize, json } = winston.format;
import "winston-daily-rotate-file";
import "winston-mongodb";
import dotenv from 'dotenv';
import util from 'util';
import crypto from 'crypto';

dotenv.config();

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
      maxFiles: '14d'
    }),
    new winston.transports.MongoDB({
      level: 'debug', // Set to the lowest level to log all levels
      db: MONGODB_URI,
      options: {
        useUnifiedTopology: true
      },
      collection: 'logs',
      format: json(),
      tryReconnect: true,
      metaKey: 'metadata'
    })
  ]
});

/**
 * Main logging function
 * @param {string} level - Log level (error, warn, info, debug)
 * @param {string} source - Source of the log (e.g., 'Sync-Service', 'Auth-Route')
 * @param {string} message - Log message
 * @param {object} meta - Additional metadata
 * @param {object} context - Context object containing ip, email, userId, userRole, request info, etc.
 */
const log = (level, source, message, meta = {}, context = {}) => {
  // Extract context data with fallbacks
  const ip = context.ip || 'N/A';
  const email = context.email || 'N/A';
  const userId = context.userId || 'N/A';
  const userRole = context.userRole || 'N/A';
  
  // Check if this is a duplicate log entry (only if deduplication is enabled)
  if (ENABLE_DEDUP && isDuplicateLog(level, source, message, meta, context)) {
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

  // Enhanced metadata structure for better diagnostics
  const enhancedMeta = {
    source,
    ip,
    email,
    userId,
    userRole,
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
    // Add request context if available
    requestContext: context.method ? {
      method: context.method,
      url: context.url,
      userAgent: context.userAgent,
      referer: context.referer,
      workspaceId: context.workspaceId || meta.workspaceId,
      boardId: context.boardId || meta.boardId
    } : {}
  };

  logger.log(level, message, enhancedMeta);
};

/**
 * Helper function to extract context from Express request object
 * This makes it easier to migrate existing code that passes req
 * @param {object} req - Express request object
 * @returns {object} Context object
 */
export const extractContextFromReq = (req) => {
  if (!req) return {};
  
  return {
    ip: req.ip?.split(':').pop(),
    email: req.user?.email,
    userId: req.user?.id,
    userRole: req.user?.role,
    method: req.method,
    url: req.url,
    userAgent: req.get ? req.get('User-Agent') : undefined,
    referer: req.get ? req.get('Referer') : undefined,
    workspaceId: req.params?.workspaceId || req.body?.workspaceId,
    boardId: req.params?.boardId || req.body?.boardId,
    requestId: req.headers?.['x-request-id']
  };
};

export const error = (source, message, meta = {}, context = {}) => log('error', source, message, meta, context);
export const warn = (source, message, meta = {}, context = {}) => log('warn', source, message, meta, context);
export const info = (source, message, meta = {}, context = {}) => log('info', source, message, meta, context);
export const debug = (source, message, meta = {}, context = {}) => log('debug', source, message, meta, context);

// Enhanced error logging for attribute-related issues
export const logAttributeError = (source, message, attributeId, metadata, context = {}) => {
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
export const logApiError = (source, message, apiContext, context = {}) => {
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

// Context-aware logging for operation flow tracking
export const logOperationStart = (source, operation, metadata, context = {}) => {
  const operationContext = {
    operationType: 'OPERATION_START',
    operation,
    ...metadata,
    timestamp: new Date().toISOString(),
    requestId: context.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  info(source, `Starting operation: ${operation}`, operationContext, context);
};

export const logOperationEnd = (source, operation, metadata, context = {}, success = true) => {
  const operationContext = {
    operationType: 'OPERATION_END',
    operation,
    ...metadata,
    success,
    timestamp: new Date().toISOString(),
    requestId: context.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  const level = success ? 'info' : 'warn';
  log(level, source, `Completed operation: ${operation}`, operationContext, context);
};

export default logger;
