import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';

dotenv.config();

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    enableLogs: true,
    sendDefaultPii: true,
  });
}
