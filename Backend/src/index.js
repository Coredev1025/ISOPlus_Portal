import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
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
import session from 'express-session';
import MongoStore from 'connect-mongo';
import syncWorker, { checkAndRetryFailedJobs } from './workers/syncWorker.js'; // Initialize sync worker
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { syncQueue } from './services/sync/queue.js';

dotenv.config();

const requiredEnvVars = ['MONGODB_URI', 'JWT_SECRET', 'SESSION_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(' ').filter(Boolean)
  : ['http://localhost:3000'];

app.use(cors({
  origin: allowedOrigins, 
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookies', 'X-API-Version', 'Accept'],
  credentials: true,
  optionsSuccessStatus: 200 
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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
    secure: false,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

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
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Check and retry failed jobs on server startup
  // Add a delay to ensure Redis connection and queue are fully initialized
  setTimeout(async () => {
    try {
      console.log('Checking for failed jobs to retry on startup...');
      await checkAndRetryFailedJobs();
    } catch (err) {
      console.error('Error checking failed jobs on startup:', err);
    }
  }, 3000); // 3 second delay to ensure everything is initialized
});