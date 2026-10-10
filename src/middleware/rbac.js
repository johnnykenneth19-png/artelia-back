const AppError = require('../utils/AppError');
const { supabaseAdmin } = require('../config/supabase');

/**
 * requireRole(['artist','admin']) — blocks unless req.user.role is in the list.
 * Must run after authenticate().
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Authentication required.', 401, 'UNAUTHENTICATED'));
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403, 'FORBIDDEN'));
    }
    next();
  };
}

/**
 * requireAdmin(['finance_admin','super_admin']) — checks the admin_users
 * table for a fine-grained admin_role, separate from the coarse
 * users.primary_role, so a moderator never accidentally gets financial access.
 */
function requireAdmin(...allowedAdminRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');

      const { data: admin, error } = await supabaseAdmin
        .from('admin_users')
        .select('admin_role')
        .eq('user_id', req.user.id)
        .single();

      if (error || !admin) {
        throw new AppError('Admin access required.', 403, 'FORBIDDEN');
      }

      if (allowedAdminRoles.length && !allowedAdminRoles.includes(admin.admin_role)) {
        throw new AppError('This action requires a higher admin permission level.', 403, 'FORBIDDEN');
      }

      req.adminRole = admin.admin_role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * requireArtworkOwnership — loads the artwork and confirms the
 * authenticated artist owns it (or the caller is an admin) before
 * allowing mutation. Prevents Artist A from editing Artist B's artwork
 * even if they guess/enumerate the artwork ID.
 */
async function requireArtworkOwnership(req, res, next) {
  try {
    const { id } = req.params;

    const { data: artwork, error } = await supabaseAdmin
      .from('artworks')
      .select('id, artist_id, status, reserved_by_order_id, artist_profiles!inner(user_id)')
      .eq('id', id)
      .single();

    if (error || !artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');

    const isOwner = artwork.artist_profiles.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

    if (!isOwner && !isAdmin) {
      throw new AppError('You do not have permission to modify this artwork.', 403, 'FORBIDDEN');
    }

    req.artwork = artwork;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireRole, requireAdmin, requireArtworkOwnership };
