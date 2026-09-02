#!/usr/bin/env node
//
// Create a one-time Google support-admin OAuth ticket in local Mongo for E2E
// tests. Uses the same oauth-exchange path as production — no auth bypass in
// the application.
//
//   node scripts/e2e-support-ticket.mjs
//   E2E_SUPPORT_TICKET=$(node scripts/e2e-support-ticket.mjs)

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.MONGODB_URI) {
  const envFile = join(backendRoot, '.env');
  if (existsSync(envFile)) {
    const { config } = await import('dotenv');
    config({ path: envFile });
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('error: MONGODB_URI is not set');
  process.exit(1);
}

if (!/(?:@|\/\/)(?:localhost|127\.0\.0\.1|mongo)[:/]/.test(uri)) {
  console.error('error: refusing to run — MONGODB_URI is not local');
  process.exit(1);
}

const email =
  process.env.E2E_SUPPORT_EMAIL ||
  `e2e-support-${Date.now()}@isoconsultingservices.com.au`;

const mongoose = (await import('mongoose')).default;
await mongoose.connect(uri);

const { default: OAuthTicket } = await import(
  pathToFileURL(join(backendRoot, 'src/models/OAuthTicket.js')).href
);

const ticket = randomBytes(24).toString('hex');
const expiresAt = new Date(Date.now() + 300_000);

await OAuthTicket.create({
  ticket,
  expiresAt,
  flow: 'google-support',
  accessToken: '',
  oauthData: {
    id: `e2e-google-${Date.now()}`,
    email,
    name: 'E2E Support Admin',
    photo_url: '',
  },
});

await mongoose.disconnect();
process.stdout.write(ticket);
