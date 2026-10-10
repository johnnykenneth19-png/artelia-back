const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const artworkService = require('./artworkService');
const ledgerService = require('./ledgerService');
const feeService = require('./feeService');
const paymentService = require('./paymentService');
const cartService = require('./cartService');
const marketingService = require('./marketingService');
const resaleService = require('./resaleService');

/**
 * ORDER SERVICE — checkout orchestration (spec sections 15, 16, 49, 50).
 * ---------------------------------------------------------------------
 * Checkout has to get three things right simultaneously:
 *   1. Pricing is always re-read from the database, never trusted from
 *      the cart the client sent (section 15).
 *   2. Each unique artwork is atomically reserved so two buyers can never
 *      both complete a purchase of the same item (section 49) — this
 *      delegates to artworkService.reserveForCheckout, itself a single
 *      conditional UPDATE.
 *   3. If ANY item in the cart can't be reserved, the whole checkout
 *      fails cleanly and anything already reserved in this attempt is
 *      released — no half-completed orders holding artwork hostage.
 *
 * FEE GATEWAY: "order_payment_processing" — if admin has an active fee
 * configured for order payments, it's resolved here and added to the
 * order total as its own line (orders.processing_fee_amount) so the
 * buyer sees exactly what they're being charged and why, rather than a
 * silently inflated artwork price.
 */

async function generateOrderNumber() {
  const { data, error } = await supabaseAdmin.rpc('next_order_number');
  if (error) throw new AppError('Could not generate order number.', 500, 'ORDER_NUMBER_FAILED');
  return data;
}

async function createFromCart(buyerId, { shippingAddress, billingAddress, discountCode } = {}) {
  const cartItems = await cartService.listMine(buyerId);
  if (!cartItems.length) throw new AppError('Your cart is empty.', 400, 'CART_EMPTY');

  const unavailable = cartItems.filter((i) => !i.isAvailable);
  if (unavailable.length) {
    throw new AppError(
      `Some items in your cart are no longer available: ${unavailable.map((i) => i.artworks?.title).join(', ')}. Please remove them to continue.`,
      409,
      'CART_HAS_UNAVAILABLE_ITEMS'
    );
  }

  // MVP constraint: a single order is single-currency. Multi-currency
  // cart splitting is a Phase 5+ UX concern, not a data-model one — the
  // schema already supports it per-order.
  const currency = cartItems[0].artworks.currency;
  if (cartItems.some((i) => i.artworks.currency !== currency)) {
    throw new AppError('Please check out artworks in the same currency separately for now.', 400, 'MIXED_CURRENCY_CART');
  }

  const subtotal = round2(cartItems.reduce((sum, i) => sum + Number(i.artworks.price), 0));

  // FEE GATEWAY: order payment processing fee (admin-configurable, optional).
  const feeResolution = await feeService.resolveApplicableFee('order_payment_processing', { baseAmount: subtotal, currency });
  const processingFeeAmount = feeResolution ? feeResolution.amount : 0;

  const shippingFee = 0; // TODO(Phase 7 - shipping): real shipping calculation by destination/courier.
  const taxAmount = 0; // TODO(Phase 5+ - tax): jurisdiction-aware tax calculation.

  // MARKETING GATEWAY: discount code (spec sections 16, 44, 64) — resolved
  // and validated server-side against the real subtotal; a frontend can
  // never supply its own discount amount. resolveDiscount throws a clear
  // 400 if the code is invalid/expired/exhausted/not yet usable.
  let discountResolution = null;
  if (discountCode) {
    discountResolution = await marketingService.resolveDiscount(discountCode, { buyerId, subtotal, currency });
  }
  const discountAmount = discountResolution ? discountResolution.amount : 0;
  const totalAmount = round2(subtotal + shippingFee + taxAmount + processingFeeAmount - discountAmount);

  const orderNumber = await generateOrderNumber();

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .insert({
      order_number: orderNumber,
      buyer_id: buyerId,
      status: 'pending_payment',
      subtotal,
      shipping_fee: shippingFee,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      discount_code: discountResolution ? discountResolution.code : null,
      processing_fee_amount: processingFeeAmount,
      total_amount: totalAmount,
      currency,
      shipping_address: shippingAddress || null,
      billing_address: billingAddress || null,
    })
    .select('*')
    .single();

  if (orderErr) throw new AppError('Could not create order.', 500, 'ORDER_CREATE_FAILED');

  if (discountResolution) {
    await marketingService.recordRedemption(discountResolution.discountCodeId, order.id, buyerId, discountAmount);
  }

  // Reserve every artwork atomically. If any single one fails (someone
  // else just bought it), roll back everything already reserved in this
  // same checkout attempt and cancel the order — never leave a partial hold.
  const reserved = [];
  try {
    for (const item of cartItems) {
      const result = await artworkService.reserveForCheckout(item.artworks.id, order.id);
      reserved.push({ artworkId: item.artworks.id, artistId: result.artist_id, price: result.price, currency: result.currency });
    }
  } catch (err) {
    for (const r of reserved) {
      await artworkService.releaseReservation(r.artworkId, order.id).catch(() => {});
    }
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw err; // artworkService already throws a clear 409 ARTWORK_UNAVAILABLE
  }

  // Snapshot each item's price and applicable commission rate at the
  // moment of sale — both must be immutable from here even if the admin
  // changes commission rules or the artist edits the (now-locked) artwork later.
  const orderItemRows = [];
  for (const r of reserved) {
    const { data: artworkRow } = await supabaseAdmin.from('artworks').select('category_id').eq('id', r.artworkId).single();
    const commissionRate = await ledgerService.resolveCommissionRate({ artistId: r.artistId, categoryId: artworkRow?.category_id });
    orderItemRows.push({
      order_id: order.id,
      artwork_id: r.artworkId,
      artist_id: r.artistId,
      unit_price: r.price,
      currency: r.currency,
      commission_rate: commissionRate,
    });
  }

  const { error: itemsErr } = await supabaseAdmin.from('order_items').insert(orderItemRows);
  if (itemsErr) {
    for (const r of reserved) await artworkService.releaseReservation(r.artworkId, order.id).catch(() => {});
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw new AppError('Could not finalize order items.', 500, 'ORDER_ITEMS_FAILED');
  }

  await cartService.clear(buyerId);

  const { authorizationUrl } = await paymentService.initiatePayment(order);

  return { order, authorizationUrl };
}

/**
 * Creates an order from an ACCEPTED offer, at the negotiated amount —
 * not the artwork's listed price. This is the "controlled checkout
 * flow" spec section 18 asks for: the moment an offer is accepted, the
 * artwork is reserved and a real order is created at the agreed price,
 * so the buyer only has to complete payment. Called from
 * offerService.accept() — never exposed as a route the buyer calls
 * directly, since the price must come from the offer, not the client.
 */
async function createFromOffer(offer) {
  const { data: artwork } = await supabaseAdmin.from('artworks').select('category_id').eq('id', offer.artwork_id).maybeSingle();
  if (!artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');

  const subtotal = round2(Number(offer.amount));
  const feeResolution = await feeService.resolveApplicableFee('order_payment_processing', { baseAmount: subtotal, currency: offer.currency });
  const processingFeeAmount = feeResolution ? feeResolution.amount : 0;
  const totalAmount = round2(subtotal + processingFeeAmount);

  const orderNumber = await generateOrderNumber();

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .insert({
      order_number: orderNumber,
      buyer_id: offer.buyer_id,
      status: 'pending_payment',
      subtotal,
      shipping_fee: 0,
      tax_amount: 0,
      discount_amount: 0,
      processing_fee_amount: processingFeeAmount,
      total_amount: totalAmount,
      currency: offer.currency,
    })
    .select('*')
    .single();

  if (orderErr) throw new AppError('Could not create order.', 500, 'ORDER_CREATE_FAILED');

  try {
    await artworkService.reserveForCheckout(offer.artwork_id, order.id);
  } catch (err) {
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw err;
  }

  const commissionRate = await ledgerService.resolveCommissionRate({ artistId: offer.artist_id, categoryId: artwork.category_id });

  const { error: itemErr } = await supabaseAdmin.from('order_items').insert({
    order_id: order.id,
    artwork_id: offer.artwork_id,
    artist_id: offer.artist_id,
    unit_price: subtotal,
    currency: offer.currency,
    commission_rate: commissionRate,
  });

  if (itemErr) {
    await artworkService.releaseReservation(offer.artwork_id, order.id).catch(() => {});
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw new AppError('Could not finalize order item.', 500, 'ORDER_ITEMS_FAILED');
  }

  const { authorizationUrl } = await paymentService.initiatePayment(order);
  return { order, authorizationUrl };
}

/**
 * Creates an order for a resale listing's asking price (spec section
 * 40, Phase 9) — the buyer-initiated checkout equivalent of
 * createFromOffer above, just sourced from an active resale_listings
 * row instead of an accepted offer. Reserves the artwork FROM
 * 'resale_listed' specifically (resaleService.reserveForResaleCheckout),
 * so this can never cross-match a normal first-sale checkout.
 * Called from resaleController — the price always comes from the
 * listing itself, never from the client.
 */
async function createFromResaleListing(listing, buyerId) {
  if (listing.seller_user_id === buyerId) {
    throw new AppError('You cannot buy your own resale listing.', 400, 'CANNOT_BUY_OWN_LISTING');
  }

  const subtotal = round2(Number(listing.price));
  const feeResolution = await feeService.resolveApplicableFee('order_payment_processing', { baseAmount: subtotal, currency: listing.currency });
  const processingFeeAmount = feeResolution ? feeResolution.amount : 0;
  const totalAmount = round2(subtotal + processingFeeAmount);

  const orderNumber = await generateOrderNumber();

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .insert({
      order_number: orderNumber,
      buyer_id: buyerId,
      status: 'pending_payment',
      subtotal,
      shipping_fee: 0,
      tax_amount: 0,
      discount_amount: 0,
      processing_fee_amount: processingFeeAmount,
      total_amount: totalAmount,
      currency: listing.currency,
    })
    .select('*')
    .single();

  if (orderErr) throw new AppError('Could not create order.', 500, 'ORDER_CREATE_FAILED');

  try {
    await resaleService.reserveForResaleCheckout(listing.artwork_id, order.id);
  } catch (err) {
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw err;
  }

  // commission_rate here is the PLATFORM's resale commission — the
  // seller is an ordinary collector, not an artist, so the usual
  // artist/category commission lookup doesn't apply (resaleService
  // resolves a dedicated 'resale'-scoped rule, falling back to the
  // global default — same priority mechanism as a first sale).
  const commissionRate = await resaleService.resolveResaleCommissionRate();

  // order_items.artist_id is NOT NULL — for a resale item this is the
  // ARTWORK's original artist (kept for provenance/royalty purposes),
  // never the seller. It must be present on every artwork row already.
  const originalArtistId = listing.artworks?.artist_id;
  if (!originalArtistId) {
    await resaleService.releaseResaleReservation(listing.artwork_id, order.id).catch(() => {});
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw new AppError('Could not determine the original artist for this listing.', 500, 'DATA_INTEGRITY_ERROR');
  }

  const { error: itemErr } = await supabaseAdmin.from('order_items').insert({
    order_id: order.id,
    artwork_id: listing.artwork_id,
    artist_id: originalArtistId,
    resale_listing_id: listing.id,
    unit_price: subtotal,
    currency: listing.currency,
    commission_rate: commissionRate,
  });

  if (itemErr) {
    await resaleService.releaseResaleReservation(listing.artwork_id, order.id).catch(() => {});
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw new AppError('Could not finalize order item.', 500, 'ORDER_ITEMS_FAILED');
  }

  const { authorizationUrl } = await paymentService.initiatePayment(order);
  return { order, authorizationUrl };
}

/**
 * Creates an order for an ACCEPTED commission's agreed price (spec
 * section 19, closing the gap flagged in Phase 6). No artwork exists
 * yet, so there's nothing to reserve — the order_item points at the
 * commission instead (order_items.artwork_id is nullable specifically
 * for this). Called from commissionService.accept(); never a route the
 * buyer calls directly, since the price must come from the accepted
 * proposal, not the client.
 */
async function createFromCommission(commission) {
  const subtotal = round2(Number(commission.agreed_price));
  if (!subtotal || subtotal <= 0) throw new AppError('This commission has no agreed price to charge.', 400, 'INVALID_STATE');

  const feeResolution = await feeService.resolveApplicableFee('order_payment_processing', { baseAmount: subtotal, currency: commission.currency });
  const processingFeeAmount = feeResolution ? feeResolution.amount : 0;
  const totalAmount = round2(subtotal + processingFeeAmount);

  const orderNumber = await generateOrderNumber();

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .insert({
      order_number: orderNumber,
      buyer_id: commission.buyer_id,
      status: 'pending_payment',
      subtotal,
      shipping_fee: 0,
      tax_amount: 0,
      discount_amount: 0,
      processing_fee_amount: processingFeeAmount,
      total_amount: totalAmount,
      currency: commission.currency,
    })
    .select('*')
    .single();

  if (orderErr) throw new AppError('Could not create order.', 500, 'ORDER_CREATE_FAILED');

  const commissionRate = await ledgerService.resolveCommissionRate({ artistId: commission.artist_id, categoryId: null });

  const { error: itemErr } = await supabaseAdmin.from('order_items').insert({
    order_id: order.id,
    artwork_id: null,
    commission_id: commission.id,
    artist_id: commission.artist_id,
    unit_price: subtotal,
    currency: commission.currency,
    commission_rate: commissionRate,
  });

  if (itemErr) {
    await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    throw new AppError('Could not finalize order item.', 500, 'ORDER_ITEMS_FAILED');
  }

  const { authorizationUrl } = await paymentService.initiatePayment(order);
  return { order, authorizationUrl };
}

/** The order_items (with parent order context) belonging to a given artist — their "Orders" dashboard view. */
async function listForArtist(artistProfileId, { page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('order_items')
    .select('*, orders!inner(id, order_number, status, placed_at, buyer_id, currency), artworks(title, slug), commissions(description)', { count: 'exact' })
    .eq('artist_id', artistProfileId)
    .order('placed_at', { foreignTable: 'orders', ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load orders.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function listMine(buyerId, { page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('orders')
    .select('*, order_items(*, artworks(title, slug, artwork_images(public_url, thumbnail_url, image_type)))', { count: 'exact' })
    .eq('buyer_id', buyerId)
    .order('placed_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load orders.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getMine(orderId, buyerId) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*, order_items(*, artworks(title, slug, artwork_images(public_url, thumbnail_url, image_type))), payments(status, provider, created_at)')
    .eq('id', orderId)
    .eq('buyer_id', buyerId)
    .maybeSingle();

  if (error) throw new AppError('Could not load order.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Order not found.', 404, 'NOT_FOUND');
  return data;
}

/** Buyer-initiated cancellation — only while still awaiting payment; releases every reserved artwork. */
async function cancelMine(orderId, buyerId) {
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('*, order_items(artwork_id, resale_listing_id)')
    .eq('id', orderId)
    .eq('buyer_id', buyerId)
    .in('status', ['pending_payment', 'payment_processing'])
    .maybeSingle();

  if (error) throw new AppError('Could not load order.', 500, 'QUERY_FAILED');
  if (!order) throw new AppError('Only orders awaiting payment can be cancelled.', 400, 'INVALID_STATE_TRANSITION');

  for (const item of order.order_items) {
    if (!item.artwork_id) continue;
    // A resale checkout must come back to 'resale_listed', not 'published'
    // — otherwise cancelling it would wrongly resurrect the artwork as a
    // brand-new first listing instead of the resale it actually was.
    const toStatus = item.resale_listing_id ? 'resale_listed' : 'published';
    await artworkService.releaseReservation(item.artwork_id, orderId, { toStatus }).catch(() => {});
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)
    .select('*')
    .single();

  if (updateErr) throw new AppError('Could not cancel order.', 500, 'UPDATE_FAILED');
  return updated;
}

/**
 * Background job (spec section 52): sweeps orders whose reservation
 * window has lapsed without payment and releases them. Pairs with
 * database/functions.sql's release_expired_reservations(), which frees
 * the artwork rows directly — this additionally moves the ORDER itself
 * to cancelled so it doesn't sit forever in pending_payment. Schedule
 * this via an external cron/worker calling it every 1-5 minutes; it is
 * not invoked automatically by this codebase.
 */
async function releaseExpiredOrders() {
  const { data: expiredItems } = await supabaseAdmin
    .from('order_items')
    .select('order_id, artwork_id, artworks!inner(status, reserved_until, reserved_by_order_id)')
    .lt('artworks.reserved_until', new Date().toISOString());

  const orderIds = [...new Set((expiredItems || []).map((i) => i.order_id))];
  if (!orderIds.length) return 0;

  await supabaseAdmin.from('orders').update({ status: 'cancelled' }).in('id', orderIds).eq('status', 'pending_payment');
  return orderIds.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { createFromCart, createFromOffer, createFromCommission, createFromResaleListing, listMine, listForArtist, getMine, cancelMine, releaseExpiredOrders };
