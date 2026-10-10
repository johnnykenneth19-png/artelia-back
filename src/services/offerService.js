const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const orderService = require('./orderService');
const notificationService = require('./notificationService');

/**
 * OFFER / NEGOTIATION SERVICE (spec section 18)
 * ---------------------------------------------------------------------
 * Each round of negotiation is its own `offers` row, linked to the
 * previous one via `parent_offer_id`, so the full history is a readable
 * chain rather than a single row being overwritten. `awaiting_response_from`
 * says whose turn it is; every transition below both updates the acting
 * row's status and, for a counter, opens a new row awaiting the other
 * side. Accepting — by either party — hands off to
 * orderService.createFromOffer, which is the "controlled checkout flow"
 * the spec asks for: the artwork is reserved and an order created at the
 * agreed price the instant acceptance happens, not left to chance later.
 */

const OFFER_EXPIRY_DAYS = 7;

const SELECT_FIELDS = `
  *, artworks ( id, title, slug, price, currency, offers_enabled, status, artwork_images(public_url, thumbnail_url, image_type) ),
  artist_profiles ( id, artist_name, slug, user_id )
`;

async function createOffer(buyerId, { artworkId, amount, currency }) {
  const { data: artwork, error } = await supabaseAdmin
    .from('artworks')
    .select('id, status, offers_enabled, artist_id, price, currency')
    .eq('id', artworkId)
    .maybeSingle();

  if (error || !artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');
  if (artwork.status !== 'published') throw new AppError('This artwork is not currently available.', 400, 'ARTWORK_UNAVAILABLE');
  if (!artwork.offers_enabled) throw new AppError('This artist is not accepting offers on this artwork.', 400, 'OFFERS_DISABLED');
  if (amount <= 0) throw new AppError('Offer amount must be greater than zero.', 422, 'VALIDATION_ERROR');

  const { data: offer, error: insertErr } = await supabaseAdmin
    .from('offers')
    .insert({
      artwork_id: artworkId,
      buyer_id: buyerId,
      artist_id: artwork.artist_id,
      amount,
      currency: currency || artwork.currency,
      status: 'pending',
      awaiting_response_from: 'artist',
      expires_at: new Date(Date.now() + OFFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select(SELECT_FIELDS)
    .single();

  if (insertErr) throw new AppError('Could not submit offer.', 500, 'CREATE_FAILED');

  const { data: artistProfile } = await supabaseAdmin.from('artist_profiles').select('user_id').eq('id', artwork.artist_id).single();
  await notificationService.create(artistProfile.user_id, {
    type: 'offer_received',
    title: 'New offer received',
    body: `You received an offer of ${currency} ${amount} on your artwork.`,
    data: { offerId: offer.id, artworkId },
  });

  return offer;
}

async function listForBuyer(buyerId, { status } = {}) {
  let query = supabaseAdmin.from('offers').select(SELECT_FIELDS).eq('buyer_id', buyerId).order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new AppError('Could not load offers.', 500, 'QUERY_FAILED');
  return data;
}

async function listForArtist(artistProfileId, { status } = {}) {
  let query = supabaseAdmin.from('offers').select(SELECT_FIELDS).eq('artist_id', artistProfileId).order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new AppError('Could not load offers.', 500, 'QUERY_FAILED');
  return data;
}

async function getForParticipant(offerId, userId) {
  const { data, error } = await supabaseAdmin.from('offers').select(SELECT_FIELDS).eq('id', offerId).maybeSingle();
  if (error || !data) throw new AppError('Offer not found.', 404, 'NOT_FOUND');

  const isBuyer = data.buyer_id === userId;
  const isArtist = data.artist_profiles.user_id === userId;
  if (!isBuyer && !isArtist) throw new AppError('You do not have access to this offer.', 403, 'FORBIDDEN');

  return { offer: data, role: isBuyer ? 'buyer' : 'artist' };
}

/** Artist accepts an offer awaiting their response — or buyer accepts a counteroffer awaiting theirs. */
async function accept(offerId, userId) {
  const { offer, role } = await getForParticipant(offerId, userId);

  if (offer.status !== 'pending' || offer.awaiting_response_from !== role) {
    throw new AppError('This offer is not awaiting your response.', 400, 'INVALID_STATE_TRANSITION');
  }

  const { data: updated, error } = await supabaseAdmin
    .from('offers')
    .update({ status: 'accepted' })
    .eq('id', offerId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error || !updated) throw new AppError('Could not accept offer.', 409, 'INVALID_STATE_TRANSITION');

  let checkout;
  try {
    checkout = await orderService.createFromOffer(updated);
  } catch (err) {
    // Roll the offer back to pending rather than leaving it falsely
    // "accepted" with no way to actually purchase it (e.g. the artwork
    // sold through another channel between offer and acceptance).
    await supabaseAdmin.from('offers').update({ status: 'pending' }).eq('id', offerId);
    throw err;
  }

  const notifyUserId = role === 'artist' ? offer.buyer_id : offer.artist_profiles.user_id;
  await notificationService.create(notifyUserId, {
    type: 'offer_accepted',
    title: 'Offer accepted',
    body: `Your offer of ${offer.currency} ${offer.amount} was accepted. Complete payment to secure the artwork.`,
    data: { offerId, orderId: checkout.order.id },
  });

  return { offer: updated, order: checkout.order, authorizationUrl: checkout.authorizationUrl };
}

async function reject(offerId, userId) {
  const { offer, role } = await getForParticipant(offerId, userId);
  if (offer.status !== 'pending' || offer.awaiting_response_from !== role) {
    throw new AppError('This offer is not awaiting your response.', 400, 'INVALID_STATE_TRANSITION');
  }

  const { data, error } = await supabaseAdmin.from('offers').update({ status: 'rejected' }).eq('id', offerId).select('*').single();
  if (error) throw new AppError('Could not reject offer.', 500, 'UPDATE_FAILED');

  const notifyUserId = role === 'artist' ? offer.buyer_id : offer.artist_profiles.user_id;
  await notificationService.create(notifyUserId, {
    type: 'offer_rejected',
    title: 'Offer declined',
    body: `Your offer of ${offer.currency} ${offer.amount} was declined.`,
    data: { offerId },
  });

  return data;
}

/** Either side can counter while it's their turn: closes this row, opens a new one awaiting the other party. */
async function counter(offerId, userId, amount) {
  const { offer, role } = await getForParticipant(offerId, userId);
  if (offer.status !== 'pending' || offer.awaiting_response_from !== role) {
    throw new AppError('This offer is not awaiting your response.', 400, 'INVALID_STATE_TRANSITION');
  }
  if (amount <= 0) throw new AppError('Counteroffer amount must be greater than zero.', 422, 'VALIDATION_ERROR');

  await supabaseAdmin.from('offers').update({ status: 'countered' }).eq('id', offerId);

  const nextAwaits = role === 'artist' ? 'buyer' : 'artist';

  const { data: newOffer, error } = await supabaseAdmin
    .from('offers')
    .insert({
      artwork_id: offer.artwork_id,
      buyer_id: offer.buyer_id,
      artist_id: offer.artist_id,
      amount,
      currency: offer.currency,
      status: 'pending',
      awaiting_response_from: nextAwaits,
      parent_offer_id: offer.id,
      expires_at: new Date(Date.now() + OFFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select(SELECT_FIELDS)
    .single();

  if (error) throw new AppError('Could not submit counteroffer.', 500, 'CREATE_FAILED');

  const notifyUserId = role === 'artist' ? offer.buyer_id : offer.artist_profiles.user_id;
  await notificationService.create(notifyUserId, {
    type: 'offer_countered',
    title: 'Counteroffer received',
    body: `A counteroffer of ${offer.currency} ${amount} was made.`,
    data: { offerId: newOffer.id, artworkId: offer.artwork_id },
  });

  return newOffer;
}

async function cancel(offerId, buyerId) {
  const { data, error } = await supabaseAdmin
    .from('offers')
    .update({ status: 'cancelled' })
    .eq('id', offerId)
    .eq('buyer_id', buyerId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not cancel offer.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only your own pending offers can be cancelled.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function addMessage(offerId, userId, message) {
  const { role } = await getForParticipant(offerId, userId); // throws if not a participant
  const { data, error } = await supabaseAdmin.from('offer_messages').insert({ offer_id: offerId, sender_id: userId, message }).select('*').single();
  if (error) throw new AppError('Could not send message.', 500, 'CREATE_FAILED');
  return data;
}

async function getThread(offerId, userId) {
  await getForParticipant(offerId, userId);
  const { data, error } = await supabaseAdmin.from('offer_messages').select('*').eq('offer_id', offerId).order('created_at', { ascending: true });
  if (error) throw new AppError('Could not load offer messages.', 500, 'QUERY_FAILED');
  return data;
}

/** Background job (spec section 52): expires stale pending offers. Not invoked automatically — see src/jobs/. */
async function expireStale() {
  const { data, error } = await supabaseAdmin
    .from('offers')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) throw new AppError('Could not expire offers.', 500, 'UPDATE_FAILED');
  return data?.length || 0;
}

module.exports = { createOffer, listForBuyer, listForArtist, getForParticipant, accept, reject, counter, cancel, addMessage, getThread, expireStale };
