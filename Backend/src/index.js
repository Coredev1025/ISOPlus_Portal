import './instrument.js';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import mongoSanitize from 'express-mongo-sanitize';
import axios from 'axios';
import http from 'http';
import https from 'https';
import authRoutes from './routes/auth.js';
import automationRoutes from './routes/automation.js';
import businessRoutes from './routes/business.js';
import workspaceRoutes from './routes/workspace.js';
import boardRoutes from './routes/board.js';
import xeroRoutes from './routes/xero.js';
import logRoutes from './routes/log.js';
import timeTrackRoutes from './routes/timetrack.js';
import webhookRoutes from './routes/webhook.js';
import isoplusWebhookRoutes from './routes/isoplusWebhook.js';
import auditTrailRouters from './routes/audittrail.js';
import PdfRouters from './routes/pdfLink.js';
import HealthCheckRouters from './routes/heathcheck.js';
import ndisRoutes from './routes/ndis.js';
import ageCareRoutes from './routes/ageCare.js';
import syncRoutes from './routes/sync.js';
import itemsRoutes from './routes/items.js';
import exportOptimizedRoutes from './routes/exportOptimized.js';
import subscriptionRoutes from './routes/subscription.js';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import syncWorker, { checkAndRetryFailedJobs } from './workers/syncWorker.js'; // Initialize sync worker
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { syncQueue } from './services/sync/queue.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { auditHttpMiddleware } from './middleware/auditHttp.js';
import { errorHandler } from './middleware/errorHandler.js';
import { info, error as logError } from './utils/logger.js';

dotenv.config();

axios.defaults.timeout = Math.max(parseInt(process.env.HTTP_CLIENT_TIMEOUT_MS || '30000', 10), 1000);
axios.defaults.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const requiredEnvVars = ['MONGODB_URI', 'JWT_SECRET', 'SESSION_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  // Log via application logger so it's persisted
  logError('Bootstrap', 'Missing required environment variables', { missingEnvVars });
  logError('Bootstrap', 'Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

mongoose.set('strictQuery', true);

const app = express();
app.disable('x-powered-by');

app.set('etag', false);

app.set('trust proxy', 1);

// Attach requestId and request lifecycle logging early
app.use(requestContextMiddleware);

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(/[\s,]+/).filter(Boolean)
  : ['http://localhost:3000'];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'X-API-Version',
    'X-Request-Id',
    'X-User-Action',
    'X-App-Action',
    'X-Audit-Action'
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

const requestBodyLimitBytes = 2 * 1024 * 1024; // 2 MB (SonarQube recommended max for non-file requests)
app.use(express.json({ limit: requestBodyLimitBytes }));
app.use(express.urlencoded({ extended: true, limit: requestBodyLimitBytes }));
app.use(mongoSanitize({ replaceWith: '_', allowDots: true }));

const isProduction = process.env.NODE_ENV === 'production';
// Local tunnel dev (e.g. Cloudflare quick tunnel) puts the frontend and
// backend on genuinely different sites, so the session cookie needs the same
// SameSite=None/Secure treatment as production or the browser silently drops
// it on cross-site XHR (e.g. /api/auth/verify right after login succeeds).
const crossSiteCookies = isProduction || process.env.SESSION_COOKIE_CROSS_SITE === 'true';
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/business-dashboard',
    collectionName: 'sessions',
    autoRemove: 'native'
  }),
  cookie: {
    secure: crossSiteCookies,
    httpOnly: true,
    sameSite: crossSiteCookies ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

app.use(auditHttpMiddleware);

app.use('/api/healthcheck', HealthCheckRouters);
app.use('/api/auth', authRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api/timetracks', timeTrackRoutes);
app.use('/api/xero', xeroRoutes);
app.use('/api/log', logRoutes);
app.use('/api/pdf', webhookRoutes);
app.use('/api/webhooks', isoplusWebhookRoutes);
app.use('/api/audit', auditTrailRouters);
app.use('/api/pdf-links', PdfRouters);
app.use('/api/care-management-ndis-pricing', ndisRoutes);
app.use('/api/age-care', ageCareRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/export', exportOptimizedRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

// Setup Bull Board for queue monitoring
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/api/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(syncQueue),
  ],
  serverAdapter: serverAdapter,
});

// Mount Bull Board UI
app.use('/api/queues', serverAdapter.getRouter());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => info('Bootstrap', 'Connected to MongoDB'))
  .catch((err) => logError('Bootstrap', 'MongoDB connection error', err));

process.on('unhandledRejection', (reason) => {
  logError('Process', 'Unhandled promise rejection', {
    reason: reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : reason
  });
});

process.on('uncaughtException', (err) => {
  logError('Process', 'Uncaught exception', err);
});

// Sentry Express error handler must be registered after all controllers
// and before any other error middleware (see Sentry Node SDK setup).
if (Sentry.isInitialized()) {
  Sentry.setupExpressErrorHandler(app);
}

// Global error handler (must be after routes)
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  info('Bootstrap', `Server is running on port ${PORT}`);
  
  // Check and retry failed jobs on server startup
  // Add a delay to ensure Redis connection and queue are fully initialized
  setTimeout(async () => {
    try {
      info('Bootstrap', 'Checking for failed jobs to retry on startup...');
      await checkAndRetryFailedJobs();
    } catch (err) {
      logError('Bootstrap', 'Error checking failed jobs on startup', err);
    }
  }, 3000); // 3 second delay to ensure everything is initialized
});