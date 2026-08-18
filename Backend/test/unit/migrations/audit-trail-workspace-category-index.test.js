import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  up,
  down,
} from '../../../migrations/1787097600000-audit-trail-workspace-category-index.js';

describe('audit-trail-workspace-category-index migration', () => {
  it('creates and drops the workspace+category+createdAt index', async () => {
    const audittrails = mongoose.connection.collection('audittrails');
    await up(mongoose.connection);
    const created = await audittrails.indexes();
    expect(created.some((idx) => idx.name === 'workspaceId_1_category_1_createdAt_-1')).toBe(
      true
    );

    await down(mongoose.connection);
    const dropped = await audittrails.indexes();
    expect(dropped.some((idx) => idx.name === 'workspaceId_1_category_1_createdAt_-1')).toBe(
      false
    );
  });
});
