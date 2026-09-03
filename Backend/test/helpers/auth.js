import request from 'supertest';
import jwt from 'jsonwebtoken';
import User from '../../src/models/User.js';

export async function authenticatedAgent(
  app,
  {
    email = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@isoplus.com`,
    password = 'GoodPass!1',
    name = 'Test User',
    role = 'support_admin',
  } = {}
) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

  const user = await User.create({ email, password, name, role });
  const agent = request.agent(app);

  const sessionRes = await agent.post('/api/__test/session').send({
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    avatar: user.avatar || '',
  });

  if (sessionRes.status !== 200) {
    throw new Error(`Failed to establish test session: ${sessionRes.status}`);
  }

  return { agent, user, email };
}

export function buildJwt(payload, secret = process.env.JWT_SECRET || 'test-jwt-secret') {
  return jwt.sign(payload, secret);
}
