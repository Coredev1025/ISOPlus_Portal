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
function generateLogKey(level, source, message, meta, req) {
  const ip = req?.ip?.split(':').pop() || 'N/A';
  const email = req?.user?.email || 'N/A';
  
  // Create a hash of the log content for deduplication
  const contentHash = crypto.createHash('md5').update(
    JSON.stringify({ level, source, message, meta, ip, email })
  ).digest('hex');
  
  return `${level}-${source}-${contentHash}`;
}

// Function to check if log entry is a duplicate
function isDuplicateLog(level, source, message, meta, req) {
  const key = generateLogKey(level, source, message, meta, req);
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
      capped: true,
      cappedSize: 10000000, 
      tryReconnect: true,
      metaKey: 'metadata'
    })
  ]
});

const log = (level, source, message, meta = {}, req = {}) => {
  // Check if this is a duplicate log entry (only if deduplication is enabled)
  if (ENABLE_DEDUP && isDuplicateLog(level, source, message, meta, req)) {
    return; // Skip logging if it's a duplicate
  }

  const ip = req.ip?.split(':').pop() || 'N/A';
  const email = req.user?.email || 'N/A';
  const userId = req.user?.id || 'N/A';
  const userRole = req.user?.role || 'N/A';
  
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
    requestContext: req ? {
      method: req.method,
      url: req.url,
      userAgent: req.get('User-Agent'),
      referer: req.get('Referer'),
      workspaceId: req.params?.workspaceId || req.body?.workspaceId || meta.workspaceId,
      boardId: req.params?.boardId || req.body?.boardId || meta.boardId
    } : {}
  };

  logger.log(level, message, enhancedMeta);
};

export const error = (source, message, meta, req) => log('error', source, message, meta, req);
export const warn = (source, message, meta, req) => log('warn', source, message, meta, req);
export const info = (source, message, meta, req) => log('info', source, message, meta, req);
export const debug = (source, message, meta, req) => log('debug', source, message, meta, req);

// Enhanced error logging for attribute-related issues
export const logAttributeError = (source, message, attributeId, context, req) => {
  const errorContext = {
    attributeId,
    errorType: 'ATTRIBUTE_RECOGNITION_ERROR',
    context,
    diagnosticInfo: {
      attributeIdValid: attributeId && typeof attributeId === 'string' && attributeId.length > 0,
      attributeIdFormat: attributeId ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attributeId) : false,
      timestamp: new Date().toISOString()
    }
  };
  error(source, message, errorContext, req);
};

// Enhanced error logging for API-related issues
export const logApiError = (source, message, apiContext, req) => {
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
  error(source, message, errorContext, req);
};

// Context-aware logging for operation flow tracking
export const logOperationStart = (source, operation, context, req) => {
  const operationContext = {
    operationType: 'OPERATION_START',
    operation,
    context,
    timestamp: new Date().toISOString(),
    requestId: req?.headers?.['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  info(source, `Starting operation: ${operation}`, operationContext, req);
};

export const logOperationEnd = (source, operation, context, req, success = true) => {
  const operationContext = {
    operationType: 'OPERATION_END',
    operation,
    context,
    success,
    timestamp: new Date().toISOString(),
    requestId: req?.headers?.['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  const level = success ? 'info' : 'warn';
  log(level, source, `Completed operation: ${operation}`, operationContext, req);
};

export default logger;
