import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  up,
  down,
} from '../../../migrations/1771401600000-remove-xero-connection-logs.js';

describe('remove-xero-connection-logs migration', () => {
  it('unsets xeroConnectionLogs from every business document', async () => {
    const businesses = mongoose.connection.collection('businesses');
    await businesses.insertMany([
      {
        workspaceId: 'ws-with-logs',
        name: 'Logged',
        xeroConnectionLogs: [{ message: 'Connected', outcome: 'success' }],
      },
      {
        workspaceId: 'ws-without-logs',
        name: 'Clean',
      },
    ]);

    await up(mongoose.connection);

    const withLogs = await businesses.findOne({ workspaceId: 'ws-with-logs' });
    const withoutLogs = await businesses.findOne({ workspaceId: 'ws-without-logs' });
    expect(withLogs.xeroConnectionLogs).toBeUndefined();
    expect(withoutLogs.xeroConnectionLogs).toBeUndefined();
    expect(withLogs.name).toBe('Logged');
  });

  it('down restores an empty xeroConnectionLogs array on businesses that lost the field', async () => {
    const businesses = mongoose.connection.collection('businesses');
    await businesses.insertOne({
      workspaceId: 'ws-rollback',
      name: 'Rollback',
      xeroConnectionLogs: [{ message: 'Connected', outcome: 'success' }],
    });

    await up(mongoose.connection);
    await down(mongoose.connection);

    const rolledBack = await businesses.findOne({ workspaceId: 'ws-rollback' });
    expect(rolledBack.xeroConnectionLogs).toEqual([]);
  });
});
