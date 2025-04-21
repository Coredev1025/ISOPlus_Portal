import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import authRoutes from './routes/auth.js';
import businessRoutes from './routes/business.js';
import workspaceRoutes from './routes/workspace.js';
import boardRoutes from './routes/board.js';
import xeroRoutes from './routes/xero.js';
import logRoutes from './routes/log.js';
import timeTrackRoutes from './routes/timetrack.js';
import webhookRoutes from './routes/webhook.js';
import auditTrailRouters from './routes/audittrail.js';
import PdfRouters from './routes/pdfLink.js';
import HealthCheckRouters from './routes/heathcheck.js';
dotenv.config();

const app = express();

app.use(cors({
  origin: '*', // Wildcard works, but consider limiting in production
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'], // Array is more explicit
  allowedHeaders: '*',
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/healthcheck', HealthCheckRouters);
app.use('/api/auth', authRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api/timetracks', timeTrackRoutes);
app.use('/api/xero', xeroRoutes);
app.use('/api/log', logRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/audit', auditTrailRouters);
app.use('/api/pdf', PdfRouters);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});