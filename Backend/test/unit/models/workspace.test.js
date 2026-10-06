import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import Workspace from '../../../src/models/Workspace.js';

describe('Workspace model', () => {
  it('requires name, userId and businessId', async () => {
    await expect(Workspace.create({})).rejects.toThrow();
  });

  it('creates a workspace', async () => {
    const ws = await Workspace.create({
      name: 'Main',
      userId: new mongoose.Types.ObjectId(),
      businessId: new mongoose.Types.ObjectId(),
    });
    expect(ws.name).toBe('Main');
    expect(ws.createdAt).toBeInstanceOf(Date);
  });
});
