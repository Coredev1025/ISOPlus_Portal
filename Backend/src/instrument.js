import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';

dotenv.config();

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    enableLogs: true,
    sendDefaultPii: true,
  });
}
