const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const config = require('../config');

/**
 * ADMIN USER MANAGEMENT (spec section 31) — strict RBAC. admin_role is
 * its own column on admin_users, deliberately separate from
 * users.primary_role, so a moderator can never acquire financial
 * permissions just by being listed as an admin: every finance-moving
 * route checks admin_role specifically (see middleware/rbac.js).
 *
 * Only super_admin may create/modify/remove admin users — enforced at
 * the route level, not here, but this service never assumes it.
 */

const ADMIN_ROLES = ['super_admin', 'admin', 'moderator', 'finance_admin', 'support_admin'];

async function listAdmins() {
  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .select('id, admin_role, created_at, users:user_id(id, full_name, email, is_active)')
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Could not load admin users.', 500, 'QUERY_FAILED');
  return data;
}

/**
 * Promotes an existing user to an admin role, or creates a brand-new
 * admin account outright. A super_admin should never be created through
 * a route reachable by anything less than another super_admin.
 */
async function grantAdminRole(byAdminId, { userId, email, fullName, password, adminRole }) {
  if (!adminRole || !ADMIN_ROLES.includes(adminRole)) {
    throw new AppError(`adminRole must be one of: ${ADMIN_ROLES.join(', ')}.`, 422, 'VALIDATION_ERROR');
  }

  let targetUserId = userId;

  if (!targetUserId) {
    if (!email || !fullName || !password) {
      throw new AppError('email, fullName and password are required to create a new admin user.', 422, 'VALIDATION_ERROR');
    }
    if (password.length < 10) throw new AppError('Admin passwords must be at least 10 characters.', 422, 'VALIDATION_ERROR');

    const passwordHash = await bcrypt.hash(password, config.security.bcryptSaltRounds);
    const { data: newUser, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ email, full_name: fullName, password_hash: passwordHash, primary_role: 'admin', is_email_verified: true })
      .select('id')
      .single();

    if (userError) {
      if (userError.code === '23505') throw new AppError('A user with this email already exists.', 409, 'DUPLICATE_EMAIL');
      throw new AppError('Could not create admin user.', 500, 'INSERT_FAILED');
    }
    targetUserId = newUser.id;
  }

  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .upsert({ user_id: targetUserId, admin_role: adminRole }, { onConflict: 'user_id' })
    .select('*, users:user_id(full_name, email)')
    .single();

  if (error) throw new AppError('Could not grant admin role.', 500, 'INSERT_FAILED');
  return data;
}

async function updateAdminRole(adminUserId, adminRole) {
  if (!ADMIN_ROLES.includes(adminRole)) {
    throw new AppError(`adminRole must be one of: ${ADMIN_ROLES.join(', ')}.`, 422, 'VALIDATION_ERROR');
  }
  const { data, error } = await supabaseAdmin
    .from('admin_users').update({ admin_role: adminRole }).eq('id', adminUserId).select('*, users:user_id(full_name, email)').single();
  if (error) throw new AppError('Could not update admin role.', 500, 'UPDATE_FAILED');
  return data;
}

/** Revokes admin access entirely. The underlying user account (and their order/artwork history, if any) is untouched. */
async function revokeAdmin(adminUserId, byAdminId) {
  const { data: target, error: findError } = await supabaseAdmin.from('admin_users').select('user_id').eq('id', adminUserId).maybeSingle();
  if (findError || !target) throw new AppError('Admin user not found.', 404, 'NOT_FOUND');
  if (target.user_id === byAdminId) throw new AppError('You cannot revoke your own admin access.', 400, 'CANNOT_SELF_REVOKE');

  const { error } = await supabaseAdmin.from('admin_users').delete().eq('id', adminUserId);
  if (error) throw new AppError('Could not revoke admin access.', 500, 'DELETE_FAILED');
}

/** Suspends an ordinary (non-admin) user account — spec section 29 "Suspend artists" generalizes to any user. */
async function setUserActive(userId, isActive) {
  const { data, error } = await supabaseAdmin
    .from('users').update({ is_active: isActive }).eq('id', userId).select('id, full_name, email, is_active').single();
  if (error) throw new AppError('Could not update user status.', 500, 'UPDATE_FAILED');
  return data;
}

async function listUsers({ role, search, page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from('users')
    .select('id, full_name, email, primary_role, is_active, is_email_verified, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (role) query = query.eq('primary_role', role);
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load users.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

module.exports = { ADMIN_ROLES, listAdmins, grantAdminRole, updateAdminRole, revokeAdmin, setUserActive, listUsers };
