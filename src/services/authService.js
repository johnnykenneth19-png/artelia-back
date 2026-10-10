const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.primary_role }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiresIn,
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: 'refresh' }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  });
}

async function register({ email, password, fullName }) {
  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) throw new AppError('An account with this email already exists.', 409, 'EMAIL_TAKEN');

  const passwordHash = await bcrypt.hash(password, config.security.bcryptSaltRounds);

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .insert({ email, password_hash: passwordHash, full_name: fullName, primary_role: 'buyer' })
    .select('id, email, full_name, primary_role')
    .single();

  if (error) throw new AppError('Could not create account.', 500, 'REGISTRATION_FAILED');

  await supabaseAdmin.from('user_roles').insert({ user_id: user.id, role: 'buyer' });
  await supabaseAdmin.from('buyer_profiles').insert({ user_id: user.id, display_name: fullName });

  // Issue a verification token (hashed at rest — the raw token only ever
  // exists in the email we send, never stored in plaintext).
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await supabaseAdmin.from('email_verification_tokens').insert({
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  // TODO(Phase 6 - notifications): send verification email via email service
  // using rawToken in a link like `${config.frontendUrl}/verify-email?token=${rawToken}`.

  return { user };
}

async function login({ email, password }) {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, primary_role, password_hash, is_active')
    .eq('email', email)
    .maybeSingle();

  // Deliberately generic message — do not reveal whether the email exists.
  if (error || !user) throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  if (!user.is_active) throw new AppError('This account has been deactivated.', 403, 'ACCOUNT_INACTIVE');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  await supabaseAdmin.from('sessions').insert({
    user_id: user.id,
    refresh_token_hash: refreshTokenHash,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  await supabaseAdmin.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

  return {
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.primary_role },
    accessToken,
    refreshToken,
  };
}

async function refresh(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken, config.jwt.refreshSecret);
  } catch {
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_REFRESH_TOKEN');
  }

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, revoked_at, expires_at')
    .eq('refresh_token_hash', tokenHash)
    .maybeSingle();

  if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_REFRESH_TOKEN');
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, primary_role, is_active')
    .eq('id', payload.sub)
    .single();

  if (!user || !user.is_active) throw new AppError('Account is not active.', 401, 'ACCOUNT_INACTIVE');

  return { accessToken: signAccessToken(user) };
}

async function logout(refreshToken) {
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await supabaseAdmin.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('refresh_token_hash', tokenHash);
}

module.exports = { register, login, refresh, logout };
