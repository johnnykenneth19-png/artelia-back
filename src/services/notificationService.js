const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * In-app notification creation and retrieval (spec section 34). Email/
 * push/SMS delivery is a separate concern — this only writes the
 * `notifications` row that powers the in-app bell/inbox; a background
 * job can later read unread `channel='email'`-eligible rows and dispatch
 * through an email provider without changing anything that calls create().
 */
async function create(userId, { type, title, body, data = {} }) {
  const { error } = await supabaseAdmin.from('notifications').insert({ user_id: userId, channel: 'in_app', type, title, body, data });
  if (error) console.error('[notificationService] failed to create notification:', error.message); // never let a notification failure break the calling flow
}

async function listMine(userId, { unreadOnly = false, page = 1, pageSize = 30 } = {}) {
  let query = supabaseAdmin.from('notifications').select('*', { count: 'exact' }).eq('user_id', userId).order('created_at', { ascending: false });
  if (unreadOnly) query = query.eq('is_read', false);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load notifications.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function markRead(notificationId, userId) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update notification.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Notification not found.', 404, 'NOT_FOUND');
  return data;
}

async function markAllRead(userId) {
  const { error } = await supabaseAdmin.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
  if (error) throw new AppError('Could not update notifications.', 500, 'UPDATE_FAILED');
}

module.exports = { create, listMine, markRead, markAllRead };
