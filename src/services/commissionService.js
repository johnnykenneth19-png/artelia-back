const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const notificationService = require('./notificationService');
const orderService = require('./orderService');

/**
 * COMMISSIONED ARTWORK SERVICE (spec section 19)
 * ---------------------------------------------------------------------
 * State machine: requested -> proposed -> accepted -> in_progress ->
 * delivered -> completed, with rejected/cancelled as exits from the
 * early states.
 *
 * Payment (Phase 7): accepting a proposal immediately creates a real
 * order for the agreed price via orderService.createFromCommission() —
 * order_items.artwork_id is nullable specifically so a commission (which
 * has no artwork yet) can be a valid line item through the exact same
 * payment/ledger pipeline as an artwork sale. On successful payment,
 * paymentService moves the commission to 'in_progress' automatically.
 */

const SELECT_FIELDS = `
  *, artist_profiles ( id, artist_name, slug, user_id ), mediums ( name )
`;

async function createRequest(buyerId, { artistId, description, referenceImages, preferredSize, mediumId, budget, currency, deadline }) {
  const { data: artist, error } = await supabaseAdmin.from('artist_profiles').select('id, status, user_id').eq('id', artistId).maybeSingle();
  if (error || !artist) throw new AppError('Artist not found.', 404, 'NOT_FOUND');
  if (artist.status !== 'approved') throw new AppError('This artist is not currently accepting commissions.', 400, 'ARTIST_NOT_AVAILABLE');
  if (!description || description.trim().length < 10) throw new AppError('Please describe what you\'re looking for in more detail.', 422, 'VALIDATION_ERROR');

  const { data: commission, error: insertErr } = await supabaseAdmin
    .from('commissions')
    .insert({
      buyer_id: buyerId,
      artist_id: artistId,
      description,
      reference_images: referenceImages || [],
      preferred_size: preferredSize,
      medium_id: mediumId,
      budget,
      currency,
      deadline,
      status: 'requested',
    })
    .select(SELECT_FIELDS)
    .single();

  if (insertErr) throw new AppError('Could not submit commission request.', 500, 'CREATE_FAILED');

  await notificationService.create(artist.user_id, {
    type: 'commission_requested',
    title: 'New commission request',
    body: 'A buyer has requested a custom commission from you.',
    data: { commissionId: commission.id },
  });

  return commission;
}

async function listForBuyer(buyerId) {
  const { data, error } = await supabaseAdmin.from('commissions').select(SELECT_FIELDS).eq('buyer_id', buyerId).order('created_at', { ascending: false });
  if (error) throw new AppError('Could not load commissions.', 500, 'QUERY_FAILED');
  return data;
}

async function listForArtist(artistProfileId) {
  const { data, error } = await supabaseAdmin.from('commissions').select(SELECT_FIELDS).eq('artist_id', artistProfileId).order('created_at', { ascending: false });
  if (error) throw new AppError('Could not load commissions.', 500, 'QUERY_FAILED');
  return data;
}

async function getForParticipant(commissionId, userId) {
  const { data, error } = await supabaseAdmin.from('commissions').select(SELECT_FIELDS).eq('id', commissionId).maybeSingle();
  if (error || !data) throw new AppError('Commission not found.', 404, 'NOT_FOUND');

  const isBuyer = data.buyer_id === userId;
  const isArtist = data.artist_profiles.user_id === userId;
  if (!isBuyer && !isArtist) throw new AppError('You do not have access to this commission.', 403, 'FORBIDDEN');

  return { commission: data, role: isBuyer ? 'buyer' : 'artist' };
}

async function propose(commissionId, artistUserId, { agreedPrice, estimatedCompletion, message }) {
  const { commission, role } = await getForParticipant(commissionId, artistUserId);
  if (role !== 'artist') throw new AppError('Only the artist can send a proposal.', 403, 'FORBIDDEN');
  if (commission.status !== 'requested') throw new AppError('A proposal can only be sent for a newly requested commission.', 400, 'INVALID_STATE_TRANSITION');
  if (!agreedPrice || agreedPrice <= 0) throw new AppError('A proposed price is required.', 422, 'VALIDATION_ERROR');

  const { data, error } = await supabaseAdmin
    .from('commissions')
    .update({ status: 'proposed', agreed_price: agreedPrice, estimated_completion: estimatedCompletion })
    .eq('id', commissionId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not send proposal.', 500, 'UPDATE_FAILED');

  if (message) await addMessage(commissionId, artistUserId, message);

  await notificationService.create(commission.buyer_id, {
    type: 'commission_proposed',
    title: 'Commission proposal received',
    body: `A proposal of ${commission.currency || ''} ${agreedPrice} was sent for your commission request.`,
    data: { commissionId },
  });

  return data;
}

async function accept(commissionId, buyerId) {
  const { commission, role } = await getForParticipant(commissionId, buyerId);
  if (role !== 'buyer') throw new AppError('Only the requesting buyer can accept this proposal.', 403, 'FORBIDDEN');
  if (commission.status !== 'proposed') throw new AppError('Only a proposed commission can be accepted.', 400, 'INVALID_STATE_TRANSITION');

  const { data: updated, error } = await supabaseAdmin
    .from('commissions')
    .update({ status: 'accepted' })
    .eq('id', commissionId)
    .eq('status', 'proposed')
    .select('*')
    .maybeSingle();

  if (error || !updated) throw new AppError('Could not accept proposal.', 409, 'INVALID_STATE_TRANSITION');

  let checkout;
  try {
    checkout = await orderService.createFromCommission(updated);
  } catch (err) {
    // Roll back to 'proposed' rather than leaving an "accepted" commission
    // with no way to actually pay for it.
    await supabaseAdmin.from('commissions').update({ status: 'proposed' }).eq('id', commissionId);
    throw err;
  }

  await notificationService.create(commission.artist_profiles.user_id, {
    type: 'commission_accepted',
    title: 'Commission accepted',
    body: 'The buyer accepted your proposal and payment is being processed.',
    data: { commissionId, orderId: checkout.order.id },
  });

  return { commission: updated, order: checkout.order, authorizationUrl: checkout.authorizationUrl };
}

async function reject(commissionId, userId, reason) {
  const { commission, role } = await getForParticipant(commissionId, userId);
  if (!['requested', 'proposed'].includes(commission.status)) {
    throw new AppError('This commission can no longer be declined at this stage.', 400, 'INVALID_STATE_TRANSITION');
  }

  const { data, error } = await supabaseAdmin.from('commissions').update({ status: 'rejected' }).eq('id', commissionId).select('*').single();
  if (error) throw new AppError('Could not update commission.', 500, 'UPDATE_FAILED');

  const notifyUserId = role === 'artist' ? commission.buyer_id : commission.artist_profiles.user_id;
  await notificationService.create(notifyUserId, {
    type: 'commission_rejected',
    title: 'Commission declined',
    body: reason || 'This commission request was declined.',
    data: { commissionId },
  });

  return data;
}

async function markInProgress(commissionId, artistUserId) {
  const { role } = await getForParticipant(commissionId, artistUserId);
  if (role !== 'artist') throw new AppError('Only the artist can update commission progress.', 403, 'FORBIDDEN');

  const { data, error } = await supabaseAdmin
    .from('commissions')
    .update({ status: 'in_progress' })
    .eq('id', commissionId)
    .eq('status', 'accepted')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update commission.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only an accepted commission can move to in progress.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function markDelivered(commissionId, artistUserId) {
  const { commission, role } = await getForParticipant(commissionId, artistUserId);
  if (role !== 'artist') throw new AppError('Only the artist can mark a commission delivered.', 403, 'FORBIDDEN');

  const { data, error } = await supabaseAdmin
    .from('commissions')
    .update({ status: 'delivered' })
    .eq('id', commissionId)
    .eq('status', 'in_progress')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update commission.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only an in-progress commission can be marked delivered.', 400, 'INVALID_STATE_TRANSITION');

  await notificationService.create(commission.buyer_id, {
    type: 'commission_delivered',
    title: 'Your commission has been delivered',
    body: 'Review the delivered work and mark it complete once you\'re satisfied.',
    data: { commissionId },
  });

  return data;
}

async function markCompleted(commissionId, buyerId) {
  const { role } = await getForParticipant(commissionId, buyerId);
  if (role !== 'buyer') throw new AppError('Only the buyer can mark a commission complete.', 403, 'FORBIDDEN');

  const { data, error } = await supabaseAdmin
    .from('commissions')
    .update({ status: 'completed' })
    .eq('id', commissionId)
    .eq('status', 'delivered')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update commission.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only a delivered commission can be marked complete.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function requestChanges(commissionId, buyerId) {
  const { role } = await getForParticipant(commissionId, buyerId);
  if (role !== 'buyer') throw new AppError('Only the buyer can request changes.', 403, 'FORBIDDEN');

  const { data, error } = await supabaseAdmin
    .from('commissions')
    .update({ status: 'in_progress' })
    .eq('id', commissionId)
    .eq('status', 'delivered')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update commission.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Changes can only be requested on a delivered commission.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function addMessage(commissionId, userId, message, attachmentUrl) {
  await getForParticipant(commissionId, userId); // throws if not a participant
  const { data, error } = await supabaseAdmin
    .from('commission_messages')
    .insert({ commission_id: commissionId, sender_id: userId, message, attachment_url: attachmentUrl })
    .select('*')
    .single();
  if (error) throw new AppError('Could not send message.', 500, 'CREATE_FAILED');
  return data;
}

async function getThread(commissionId, userId) {
  await getForParticipant(commissionId, userId);
  const { data, error } = await supabaseAdmin.from('commission_messages').select('*').eq('commission_id', commissionId).order('created_at', { ascending: true });
  if (error) throw new AppError('Could not load commission messages.', 500, 'QUERY_FAILED');
  return data;
}

module.exports = {
  createRequest, listForBuyer, listForArtist, getForParticipant,
  propose, accept, reject, markInProgress, markDelivered, markCompleted, requestChanges,
  addMessage, getThread,
};
