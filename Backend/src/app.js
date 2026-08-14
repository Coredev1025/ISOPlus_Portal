import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoSanitize from 'express-mongo-sanitize';

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
import schedulerRoutes from './routes/scheduler.js';
import localFilesRoutes from './routes/localFiles.js';
import systemHealthRoutes from './routes/systemHealth.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { auditHttpMiddleware } from './middleware/auditHttp.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp({ mongoUri } = {}) {
  const app = express();
  const isTest = process.env.NODE_ENV === 'test';
  const isProduction = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', 1);
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
      'X-Audit-Action',
    ],
    credentials: true,
    optionsSuccessStatus: 200,
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
  });

  const requestBodyLimitBytes = 2 * 1024 * 1024;
  app.use(express.json({ limit: requestBodyLimitBytes }));
  app.use(express.urlencoded({ extended: true, limit: requestBodyLimitBytes }));
  app.use(mongoSanitize({ replaceWith: '_', allowDots: true }));

  const sessionSecret = process.env.SESSION_SECRET || (isTest ? 'test_session_secret' : 'default_secret');
  const resolvedMongoUri = mongoUri || process.env.MONGODB_URI || 'mongodb://localhost:27017/business-dashboard';

  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      ...(!isTest && {
        store: MongoStore.create({
          mongoUrl: resolvedMongoUri,
          collectionName: 'sessions',
          autoRemove: 'native',
        }),
      }),
      cookie: {
        secure: isProduction,
        httpOnly: true,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 1000 * 60 * 60 * 24,
      },
    })
  );

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
  app.use('/api/scheduler', schedulerRoutes);
// SES delivery notifications, delivered by SNS. Unauthenticated by
// nature — the router verifies the SNS signature itself.
  // Offline-mode PDF store; 404s entirely outside offline mode.
  app.use('/api/local-files', localFilesRoutes);
  app.use('/api/system-health', systemHealthRoutes);

  app.use(errorHandler);

  return app;
}
