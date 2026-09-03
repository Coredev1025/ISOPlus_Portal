import User from '../models/User.js';
import { info } from './logger.js';

const LOG_SCOPE = 'Google-Support-User';

/**
 * Find or create a support_admin user from a verified Google profile.
 *
 * @param {{ email: string, id: string, name: string, photo_url?: string }} profile
 * @returns {Promise<import('mongoose').Document>}
 */
export async function findOrCreateGoogleSupportUser(profile) {
  const email = profile.email.toLowerCase().trim();
  const oauthId = String(profile.id);
  const name = profile.name?.trim() || email;
  const avatar = profile.photo_url || '';

  let user = await User.findOne({ oauthId });
  let matchedBy = user ? 'oauthId' : null;
  if (!user) {
    user = await User.findOne({ email });
    if (user) matchedBy = 'email';
  }

  if (!user) {
    user = new User({
      email,
      name,
      password: '',
      oauthId,
      avatar,
      role: 'support_admin',
    });
    await user.save();
    info(LOG_SCOPE, 'Created support_admin user from Google profile', {
      email,
      oauthId,
      userId: user._id?.toString(),
    });
    return user;
  }

  const previousRole = user.role;
  user.name = name;
  user.avatar = avatar;
  if (!user.oauthId) user.oauthId = oauthId;
  if (user.email !== email) user.email = email;
  user.role = 'support_admin';
  await user.save();

  info(LOG_SCOPE, 'Updated existing user from Google support sign-in', {
    email,
    oauthId,
    userId: user._id?.toString(),
    matchedBy,
    previousRole,
    role: user.role,
  });
  return user;
}
