const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const artworkService = require('./artworkService');
const ledgerService = require('./ledgerService');

/**
 * RESALE MARKETPLACE (spec section 40)
 * ---------------------------------------------------------------------
 * A buyer who owns an artwork can list that SAME artwork row for resale
 * — the spec is explicit that this must not create a disconnected
 * artwork record per resale. Ownership travels via
 * `artworks.current_owner_user_id` (set at every sale) and the
 * append-only `provenance_records` trail; `resale_listings` is just the
 * marketplace listing, not a new artwork.
 *
 * A resale purchase flows through the exact same orders/payments/ledger
 * pipeline as a first sale (orderService.createFromResaleListing mirrors
 * createFromOffer/createFromCommission) — it only posts different
 * ledger entries, via postResaleEntries below: the proceeds go to the
 * SELLER (an ordinary user, not necessarily an artist_profile), with an
 * optional artist royalty only when `artist_royalty_percentage` is
 * explicitly set (never assumed — spec: "where legally and contractually
 * applicable").
 */

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function assertCurrentOwner(artworkId, userId) {
  const { data: artwork, error } = await supabaseAdmin
    .from('artworks')
    .select('id, current_owner_user_id, status, artist_id')
    .eq('id', artworkId)
    .maybeSingle();

  if (error || !artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');
  if (artwork.status !== 'sold') {
    throw new AppError('Only an artwork you own and that is not already listed can be put up for resale.', 400, 'ARTWORK_NOT_RESELLABLE');
  }
  if (!artwork.current_owner_user_id || artwork.current_owner_user_id !== userId) {
    throw new AppError('You do not own this artwork.', 403, 'NOT_OWNER');
  }
  return artwork;
}

async function createListing(sellerUserId, { artworkId, price, currency, artistRoyaltyPercentage }) {
  if (!artworkId || !price || price <= 0 || !currency) {
    throw new AppError('artworkId, price and currency are required.', 422, 'VALIDATION_ERROR');
  }
  if (artistRoyaltyPercentage != null && (artistRoyaltyPercentage < 0 || artistRoyaltyPercentage > 100)) {
    throw new AppError('artistRoyaltyPercentage must be between 0 and 100.', 422, 'VALIDATION_ERROR');
  }

  const artwork = await assertCurrentOwner(artworkId, sellerUserId);

  // Atomically move the artwork sold -> resale_listed, the same guarded-
  // UPDATE pattern as every other status transition in this codebase
  // (spec section 49) — never a plain write.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'resale_listed' })
    .eq('id', artworkId)
    .eq('status', 'sold')
    .eq('current_owner_user_id', sellerUserId)
    .select('id')
    .maybeSingle();

  if (updateError) throw new AppError('Could not list artwork for resale.', 500, 'UPDATE_FAILED');
  if (!updated) throw new AppError('This artwork can no longer be listed — it may have changed status.', 409, 'ARTWORK_UNAVAILABLE');

  const { data: listing, error } = await supabaseAdmin
    .from('resale_listings')
    .insert({
      artwork_id: artworkId,
      seller_user_id: sellerUserId,
      price, currency,
      artist_royalty_percentage: artistRoyaltyPercentage ?? null,
    })
    .select('*')
    .single();

  if (error) {
    // Roll the artwork status back if the listing row itself failed to insert.
    await supabaseAdmin.from('artworks').update({ status: 'sold' }).eq('id', artworkId);
    throw new AppError('Could not create resale listing.', 500, 'INSERT_FAILED');
  }
  return listing;
}

async function cancelListing(listingId, sellerUserId) {
  const { data: listing, error } = await supabaseAdmin
    .from('resale_listings')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', listingId)
    .eq('seller_user_id', sellerUserId)
    .eq('status', 'active')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not cancel listing.', 500, 'UPDATE_FAILED');
  if (!listing) throw new AppError('Only your own active listings can be cancelled.', 400, 'INVALID_STATE_TRANSITION');

  await supabaseAdmin
    .from('artworks')
    .update({ status: 'sold' })
    .eq('id', listing.artwork_id)
    .eq('status', 'resale_listed');

  return listing;
}

async function listActive({ page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('resale_listings')
    .select('*, artworks(title, slug, artwork_images(url, is_main), artist_profiles(artist_name, slug))', { count: 'exact' })
    .eq('status', 'active')
    .order('listed_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load resale listings.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getActiveListing(listingId) {
  const { data, error } = await supabaseAdmin
    .from('resale_listings')
    .select('*, artworks(*, artwork_images(url, is_main))')
    .eq('id', listingId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw new AppError('Could not load listing.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('This listing is no longer available.', 404, 'NOT_FOUND');
  return data;
}

async function listMine(sellerUserId) {
  const { data, error } = await supabaseAdmin
    .from('resale_listings')
    .select('*, artworks(title, slug, artwork_images(url, is_main))')
    .eq('seller_user_id', sellerUserId)
    .order('listed_at', { ascending: false });

  if (error) throw new AppError('Could not load your listings.', 500, 'QUERY_FAILED');
  return data;
}

/**
 * Reserves the listed artwork for checkout — same atomic guarded-UPDATE
 * pattern as artworkService.reserveForCheckout, just gated on
 * 'resale_listed' instead of 'published' so the two flows can never
 * cross-match. Called from orderService.createFromResaleListing.
 */
async function reserveForResaleCheckout(artworkId, orderId) {
  return artworkService.reserveForCheckout(artworkId, orderId, { fromStatus: 'resale_listed' });
}

/** Mirror of the above for rollback — releaseReservation back to 'resale_listed', not 'published'. */
async function releaseResaleReservation(artworkId, orderId) {
  return artworkService.releaseReservation(artworkId, orderId, { toStatus: 'resale_listed' });
}

/**
 * Called once payment is confirmed (paymentService.finalizeFromEvent)
 * for a resale order_item. Transfers ownership, closes out the listing,
 * and posts the resale-specific ledger entries — proceeds to the
 * seller, never to the "artist_earning" bucket a first sale uses,
 * because the seller here is an ordinary buyer, not the artwork's artist.
 */
async function finalizeResale(orderItem, order) {
  const { data: listing, error: listingError } = await supabaseAdmin
    .from('resale_listings').select('*').eq('id', orderItem.resale_listing_id).single();
  if (listingError || !listing) throw new AppError('Resale listing not found.', 404, 'NOT_FOUND');

  await supabaseAdmin
    .from('resale_listings')
    .update({ status: 'sold', sold_at: new Date().toISOString() })
    .eq('id', listing.id);

  await supabaseAdmin
    .from('artworks')
    .update({ current_owner_user_id: order.buyer_id })
    .eq('id', orderItem.artwork_id);

  await supabaseAdmin.from('provenance_records').insert({
    artwork_id: orderItem.artwork_id,
    order_id: order.id,
    owner_user_id: order.buyer_id,
    event_type: 'resold',
    owner_label: 'Private Collector',
    notes: `Resold via ARTELIA secondary market (listing ${listing.id}).`,
  });

  await postResaleEntries({ order, orderItem, listing });
}

/**
 * Ledger postings for a resale sale (spec sections 26, 40):
 *   - platform commission (platform account, credit) — resolved via a
 *     dedicated 'resale' commission scope, falling back to the global
 *     default, same priority mechanism as a first sale.
 *   - seller earning (ledger_accounts owner_type 'buyer', owner_id =
 *     seller's user id — NOT an artist_profiles id, since the seller is
 *     an ordinary collector).
 *   - artist royalty (ledger_accounts owner_type 'artist'), ONLY when
 *     listing.artist_royalty_percentage was explicitly set.
 */
async function postResaleEntries({ order, orderItem, listing }) {
  const platformAccount = await ledgerService.getOrCreateAccount('platform', null, order.currency);
  const commissionRate = orderItem.commission_rate; // snapshotted at order creation time
  const price = Number(orderItem.unit_price);

  const platformCommission = round2((price * commissionRate) / 100);
  const royaltyPercentage = listing.artist_royalty_percentage ? Number(listing.artist_royalty_percentage) : 0;
  const artistRoyalty = royaltyPercentage ? round2((price * royaltyPercentage) / 100) : 0;
  const sellerEarning = round2(price - platformCommission - artistRoyalty);

  // ledger_entries.amount must be > 0 (schema constraint) — a 0%
  // resale commission rate simply posts no platform_commission row,
  // same as how a 0-value entry is never forced anywhere else in the
  // ledger. The platform account still gets the full payment receipt
  // via the 'payment' entry type below, so nothing is lost track of.
  await ledgerService.insertEntry({
    reference: order.order_number, ledgerAccountId: platformAccount.id,
    entryType: 'payment', direction: 'credit', amount: price,
    currency: order.currency, relatedOrderId: order.id, relatedArtworkId: orderItem.artwork_id,
  });
  if (platformCommission > 0) {
    await ledgerService.insertEntry({
      reference: order.order_number, ledgerAccountId: platformAccount.id,
      entryType: 'platform_commission', direction: 'credit', amount: platformCommission,
      currency: order.currency, relatedOrderId: order.id, relatedArtworkId: orderItem.artwork_id,
    });
  }

  const sellerAccount = await ledgerService.getOrCreateAccount('buyer', listing.seller_user_id, order.currency);
  await ledgerService.insertEntry({
    reference: order.order_number, ledgerAccountId: sellerAccount.id,
    entryType: 'artist_earning', direction: 'credit', amount: sellerEarning,
    currency: order.currency, relatedOrderId: order.id, relatedArtworkId: orderItem.artwork_id,
    relatedUserId: listing.seller_user_id,
  });
  await supabaseAdmin
    .from('ledger_accounts')
    .update({ pending_balance: Number(sellerAccount.pending_balance) + sellerEarning })
    .eq('id', sellerAccount.id);

  if (artistRoyalty > 0 && orderItem.artist_id) {
    const artistAccount = await ledgerService.getOrCreateAccount('artist', orderItem.artist_id, order.currency);
    await ledgerService.insertEntry({
      reference: order.order_number, ledgerAccountId: artistAccount.id,
      entryType: 'artist_earning', direction: 'credit', amount: artistRoyalty,
      currency: order.currency, relatedOrderId: order.id, relatedArtworkId: orderItem.artwork_id,
    });
    await supabaseAdmin
      .from('ledger_accounts')
      .update({ pending_balance: Number(artistAccount.pending_balance) + artistRoyalty })
      .eq('id', artistAccount.id);
  }
}

/** Resolves the platform's resale commission rate — a 'resale'-scoped commission_rules row, else the global default. */
async function resolveResaleCommissionRate() {
  const { data: rule } = await supabaseAdmin
    .from('commission_rules')
    .select('percentage')
    .eq('scope', 'resale')
    .eq('is_active', true)
    .maybeSingle();

  if (rule?.percentage != null) return rule.percentage;
  const config = require('../config');
  return config.platform.defaultCommissionPercentage;
}

module.exports = {
  createListing, cancelListing, listActive, getActiveListing, listMine,
  reserveForResaleCheckout, releaseResaleReservation, finalizeResale, resolveResaleCommissionRate,
};
