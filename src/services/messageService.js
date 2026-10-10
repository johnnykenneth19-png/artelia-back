const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const notificationService = require('./notificationService');

/**
 * MESSAGING SERVICE (spec section 20)
 * ---------------------------------------------------------------------
 * A "conversation" isn't its own table — it's derived from messages
 * grouped by the other participant, keeping the data model simple. Every
 * send checks the block list both ways: a blocked user can't message
 * the person who blocked them, enforced at write time, not just hidden
 * client-side.
 */

async function isBlocked(userAId, userBId) {
  const { data } = await supabaseAdmin
    .from('user_blocks')
    .select('id')
    .or(`and(blocker_id.eq.${userAId},blocked_id.eq.${userBId}),and(blocker_id.eq.${userBId},blocked_id.eq.${userAId})`)
    .maybeSingle();
  return !!data;
}

async function send(senderId, recipientId, { body, artworkId, orderId, offerId, commissionId, attachmentUrls = [] }) {
  if (senderId === recipientId) throw new AppError('You cannot message yourself.', 400, 'INVALID_RECIPIENT');
  if (!body || !body.trim()) throw new AppError('Message cannot be empty.', 422, 'VALIDATION_ERROR');

  if (await isBlocked(senderId, recipientId)) {
    throw new AppError('This conversation is not available.', 403, 'BLOCKED');
  }

  const { data: message, error } = await supabaseAdmin
    .from('messages')
    .insert({
      sender_id: senderId,
      recipient_id: recipientId,
      artwork_id: artworkId || null,
      order_id: orderId || null,
      offer_id: offerId || null,
      commission_id: commissionId || null,
      body,
    })
    .select('*')
    .single();

  if (error) throw new AppError('Could not send message.', 500, 'CREATE_FAILED');

  if (attachmentUrls.length) {
    const rows = attachmentUrls.map((url) => ({ message_id: message.id, file_url: url }));
    await supabaseAdmin.from('message_attachments').insert(rows);
  }

  await notificationService.create(recipientId, {
    type: 'new_message',
    title: 'New message',
    body: body.length > 80 ? body.slice(0, 77) + '...' : body,
    data: { messageId: message.id, fromUserId: senderId },
  });

  return message;
}

/**
 * Derives the conversation list for a user: the most recent message with
 * each other party, plus an unread count. Not the most efficient query
 * pattern at very large scale (a dedicated conversations summary table
 * is the natural Phase 8+ optimization once volume warrants it — spec
 * section 53's caching guidance applies here first), but correct and
 * simple for now.
 */
async function listConversations(userId) {
  const { data: messages, error } = await supabaseAdmin
    .from('messages')
    .select('*, sender:sender_id(id, full_name, email), recipient:recipient_id(id, full_name, email)')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(500); // recent window; paginate properly once this becomes the bottleneck

  if (error) throw new AppError('Could not load conversations.', 500, 'QUERY_FAILED');

  const byCounterpart = new Map();
  for (const m of messages) {
    const counterpart = m.sender_id === userId ? m.recipient : m.sender;
    if (!counterpart) continue;
    if (!byCounterpart.has(counterpart.id)) {
      byCounterpart.set(counterpart.id, { counterpart, lastMessage: m, unreadCount: 0 });
    }
    if (m.recipient_id === userId && !m.is_read) {
      byCounterpart.get(counterpart.id).unreadCount++;
    }
  }

  return Array.from(byCounterpart.values());
}

async function getThread(userId, otherUserId) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*, message_attachments(file_url, file_type)')
    .or(`and(sender_id.eq.${userId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${userId})`)
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Could not load messages.', 500, 'QUERY_FAILED');

  const unreadIds = data.filter((m) => m.recipient_id === userId && !m.is_read).map((m) => m.id);
  if (unreadIds.length) {
    await supabaseAdmin.from('messages').update({ is_read: true }).in('id', unreadIds);
  }

  return data;
}

async function report(messageId, reporterId, reason) {
  if (!reason || !reason.trim()) throw new AppError('A reason is required to report a message.', 422, 'VALIDATION_ERROR');

  const { data: message } = await supabaseAdmin.from('messages').select('id, sender_id, recipient_id').eq('id', messageId).maybeSingle();
  if (!message) throw new AppError('Message not found.', 404, 'NOT_FOUND');
  if (message.sender_id !== reporterId && message.recipient_id !== reporterId) {
    throw new AppError('You can only report messages in your own conversations.', 403, 'FORBIDDEN');
  }

  const { data, error } = await supabaseAdmin.from('message_reports').insert({ message_id: messageId, reported_by: reporterId, reason }).select('*').single();
  if (error) throw new AppError('Could not submit report.', 500, 'CREATE_FAILED');
  return data;
}

async function blockUser(blockerId, blockedId) {
  if (blockerId === blockedId) throw new AppError('You cannot block yourself.', 400, 'INVALID_TARGET');
  const { error } = await supabaseAdmin.from('user_blocks').upsert({ blocker_id: blockerId, blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
  if (error) throw new AppError('Could not block user.', 500, 'CREATE_FAILED');
}

async function unblockUser(blockerId, blockedId) {
  const { error } = await supabaseAdmin.from('user_blocks').delete().eq('blocker_id', blockerId).eq('blocked_id', blockedId);
  if (error) throw new AppError('Could not unblock user.', 500, 'DELETE_FAILED');
}

async function listBlocked(userId) {
  const { data, error } = await supabaseAdmin.from('user_blocks').select('blocked_id, created_at, blocked:blocked_id(full_name, email)').eq('blocker_id', userId);
  if (error) throw new AppError('Could not load blocked users.', 500, 'QUERY_FAILED');
  return data;
}

module.exports = { send, listConversations, getThread, report, blockUser, unblockUser, listBlocked, isBlocked };
