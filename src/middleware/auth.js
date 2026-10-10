const jwt = require('jsonwebtoken');
const config = require('../config');
const AppError = require('../utils/AppError');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Verifies the access token from the Authorization header and attaches
 * a minimal, trusted req.user object. Never trust any user identity
 * claimed in the request body — always derive it from this token.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');

    let payload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret);
    } catch (e) {
      throw new AppError('Invalid or expired session. Please log in again.', 401, 'INVALID_TOKEN');
    }

    // Re-check the user still exists and is active — a revoked/suspended
    // account should lose access immediately, not just after token expiry.
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, primary_role, is_active')
      .eq('id', payload.sub)
      .single();

    if (error || !user || !user.is_active) {
      throw new AppError('Account is not active.', 401, 'ACCOUNT_INACTIVE');
    }

    req.user = { id: user.id, email: user.email, role: user.primary_role };
    next();
  } catch (err) {
    next(err);
  }
}

// Like authenticate, but does not fail if there's no token — useful for
// public endpoints that personalize output when a user happens to be logged in.
async function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  return authenticate(req, res, next);
}

module.exports = { authenticate, optionalAuthenticate };
