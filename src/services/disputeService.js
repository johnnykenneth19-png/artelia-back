const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const paymentService = require('./paymentService');
const certificateService = require('./certificateService');
const notificationService = require('./notificationService');

/**
 * BUYER PROTECTION / DISPUTES (spec section 24)
 * ---------------------------------------------------------------------
 * A dispute can only be raised against an order the buyer actually
 * placed, past the point of payment. Admin resolution is the only path
 * that moves money — never automatic, never buyer-self-service — and
 * every resolution type is handled explicitly rather than a generic
 * "approve/deny" with hidden side effects.
 */

const VALID_REASONS = ['non_delivery', 'damaged_artwork', 'wrong_artwork', 'misrepresented_artwork', 'unauthorized_transaction', 'other'];

async function create(buyerId, orderId, { reason, description, evidenceUrls = [] }) {
  if (!VALID_REASONS.includes(reason)) throw new AppError('Invalid dispute reason.', 422, 'VALIDATION_ERROR');

  const { data: order } = await supabaseAdmin.from('orders').select('id, status, buyer_id').eq('id', orderId).eq('buyer_id', buyerId).maybeSingle();
  if (!order) throw new AppError('Order not found.', 404, 'NOT_FOUND');

  const disputableStatuses = ['paid', 'processing', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered', 'completed'];
  if (!disputableStatuses.includes(order.status)) {
    throw new AppError('A dispute can only be raised for a paid order.', 400, 'INVALID_STATE');
  }

  const { data: existing } = await supabaseAdmin.from('disputes').select('id').eq('order_id', orderId).eq('status', 'open').maybeSingle();
  if (existing) throw new AppError('An open dispute already exists for this order.', 409, 'ALREADY_EXISTS');

  const { data: dispute, error } = await supabaseAdmin
    .from('disputes')
    .insert({ order_id: orderId, raised_by: buyerId, reason, description, evidence_urls: evidenceUrls, status: 'open' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not submit dispute.', 500, 'CREATE_FAILED');

  await supabaseAdmin.from('orders').update({ status: 'disputed' }).eq('id', orderId);
  return dispute;
}

async function listMine(buyerId) {
  const { data, error } = await supabaseAdmin.from('disputes').select('*, orders(order_number, total_amount, currency)').eq('raised_by', buyerId).order('created_at', { ascending: false });
  if (error) throw new AppError('Could not load disputes.', 500, 'QUERY_FAILED');
  return data;
}

async function getMine(disputeId, buyerId) {
  const { data, error } = await supabaseAdmin.from('disputes').select('*, orders(*)').eq('id', disputeId).eq('raised_by', buyerId).maybeSingle();
  if (error || !data) throw new AppError('Dispute not found.', 404, 'NOT_FOUND');
  return data;
}

// ---- Admin ----

async function listAll({ status, page = 1, pageSize = 30 } = {}) {
  let query = supabaseAdmin
    .from('disputes')
    .select('*, orders(order_number, total_amount, currency, buyer_id)', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load disputes.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function startReview(disputeId, adminId) {
  const { data, error } = await supabaseAdmin
    .from('disputes')
    .update({ status: 'under_review' })
    .eq('id', disputeId)
    .eq('status', 'open')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update dispute.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only an open dispute can enter review.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

/**
 * Resolves a dispute. `resolutionType` drives what actually happens:
 *   - 'refund'          -> full refund via paymentService.issueRefund
 *   - 'partial_refund'  -> refund of `refundAmount` only
 *   - 'return'          -> full refund + certificate invalidated (the
 *                          piece is coming back; its current certificate
 *                          no longer reflects a valid completed sale)
 *   - 'continue'        -> no financial action; dispute dismissed as resolved
 *   - 'release_payout'  -> explicitly sides with the artist; no refund,
 *                          closes the dispute without further action
 */
async function resolve(disputeId, adminId, { resolutionType, refundAmount, notes }) {
  const { data: dispute, error } = await supabaseAdmin.from('disputes').select('*, orders(*)').eq('id', disputeId).in('status', ['open', 'under_review']).maybeSingle();
  if (error || !dispute) throw new AppError('Only an open or under-review dispute can be resolved.', 400, 'INVALID_STATE_TRANSITION');

  let refund = null;

  if (resolutionType === 'refund' || resolutionType === 'return') {
    refund = await paymentService.issueRefund(dispute.order_id, dispute.orders.total_amount, notes || `Dispute resolution: ${resolutionType}`, disputeId);
  } else if (resolutionType === 'partial_refund') {
    if (!refundAmount || refundAmount <= 0) throw new AppError('A refund amount is required for a partial refund.', 422, 'VALIDATION_ERROR');
    refund = await paymentService.issueRefund(dispute.order_id, refundAmount, notes || 'Dispute resolution: partial refund', disputeId);
  } else if (!['continue', 'release_payout'].includes(resolutionType)) {
    throw new AppError('Invalid resolution type.', 422, 'VALIDATION_ERROR');
  }

  if (resolutionType === 'return') {
    const { data: items } = await supabaseAdmin.from('order_items').select('artwork_id').eq('order_id', dispute.order_id);
    for (const item of items) {
      if (!item.artwork_id) continue;
      const { data: cert } = await supabaseAdmin.from('artwork_certificates').select('certificate_number').eq('artwork_id', item.artwork_id).maybeSingle();
      if (cert) await certificateService.invalidate(cert.certificate_number, 'Order returned following dispute resolution.');
      await supabaseAdmin.from('artworks').update({ status: 'unavailable' }).eq('id', item.artwork_id).eq('status', 'sold');
    }
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('disputes')
    .update({
      status: 'resolved',
      resolution: notes,
      resolution_type: resolutionType,
      refund_id: refund?.id || null,
      resolved_by: adminId,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', disputeId)
    .select('*')
    .single();

  if (updateErr) throw new AppError('Could not finalize dispute resolution.', 500, 'UPDATE_FAILED');

  await notificationService.create(dispute.raised_by, {
    type: 'dispute_resolved',
    title: 'Your dispute has been resolved',
    body: notes || `Resolution: ${resolutionType.replace('_', ' ')}`,
    data: { disputeId },
  });

  return updated;
}

async function reject(disputeId, adminId, notes) {
  const { data, error } = await supabaseAdmin
    .from('disputes')
    .update({ status: 'rejected', resolution: notes, resolution_type: 'continue', resolved_by: adminId, resolved_at: new Date().toISOString() })
    .eq('id', disputeId)
    .in('status', ['open', 'under_review'])
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update dispute.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only an open or under-review dispute can be rejected.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

module.exports = { create, listMine, getMine, listAll, startReview, resolve, reject };
