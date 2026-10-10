const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const notificationService = require('./notificationService');

/**
 * SHIPPING / TRACKING SERVICE (spec section 23)
 * ---------------------------------------------------------------------
 * One shipment per order (an order with multiple artworks from
 * different artists still ships as one parcel in this model — splitting
 * per-artist shipments is a reasonable future refinement, not built
 * here). Created automatically the moment an order's payment is
 * confirmed (see paymentService.finalizeFromEvent), starting at
 * 'processing'. The artist (any artist with an item in the order) can
 * advance it to shipped with courier/tracking details; status changes
 * append an auditable tracking_events row rather than just overwriting
 * the shipment's current status blindly.
 */

const VALID_TRANSITIONS = {
  processing: ['ready_for_shipment', 'returned'],
  ready_for_shipment: ['shipped'],
  shipped: ['in_transit', 'delivered', 'lost', 'damaged'],
  in_transit: ['delivered', 'lost', 'damaged'],
  delivered: ['return_requested'],
  return_requested: ['returned'],
};

async function createForOrder(orderId) {
  const { data: existing } = await supabaseAdmin.from('shipments').select('id').eq('order_id', orderId).maybeSingle();
  if (existing) return existing;

  const { data, error } = await supabaseAdmin.from('shipments').insert({ order_id: orderId, status: 'processing' }).select('*').single();
  if (error) throw new AppError('Could not create shipment.', 500, 'CREATE_FAILED');

  await supabaseAdmin.from('tracking_events').insert({ shipment_id: data.id, status: 'processing', description: 'Order confirmed — preparing for shipment.' });
  return data;
}

async function getForOrder(orderId) {
  const { data, error } = await supabaseAdmin
    .from('shipments')
    .select('*, tracking_events(*)')
    .eq('order_id', orderId)
    .order('occurred_at', { foreignTable: 'tracking_events', ascending: true })
    .maybeSingle();

  if (error) throw new AppError('Could not load shipment.', 500, 'QUERY_FAILED');
  return data;
}

/** Verifies the caller is an artist with at least one item in the shipment's order (any contributing artist may update it). */
async function assertArtistOwnsShipment(shipmentId, artistProfileId) {
  const { data: shipment } = await supabaseAdmin.from('shipments').select('id, order_id, status').eq('id', shipmentId).maybeSingle();
  if (!shipment) throw new AppError('Shipment not found.', 404, 'NOT_FOUND');

  const { data: item } = await supabaseAdmin
    .from('order_items')
    .select('id')
    .eq('order_id', shipment.order_id)
    .eq('artist_id', artistProfileId)
    .maybeSingle();

  if (!item) throw new AppError('You do not have permission to update this shipment.', 403, 'FORBIDDEN');
  return shipment;
}

async function updateStatus(shipmentId, artistProfileId, { status, courier, trackingNumber, description }) {
  const shipment = await assertArtistOwnsShipment(shipmentId, artistProfileId);

  const allowed = VALID_TRANSITIONS[shipment.status] || [];
  if (!allowed.includes(status)) {
    throw new AppError(`Cannot move shipment from '${shipment.status}' to '${status}'.`, 400, 'INVALID_STATE_TRANSITION');
  }

  const updates = { status };
  if (courier) updates.courier = courier;
  if (trackingNumber) updates.tracking_number = trackingNumber;
  if (status === 'shipped') updates.shipped_at = new Date().toISOString();
  if (status === 'delivered') updates.delivered_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin.from('shipments').update(updates).eq('id', shipmentId).select('*, orders(buyer_id, order_number)').single();
  if (error) throw new AppError('Could not update shipment.', 500, 'UPDATE_FAILED');

  await supabaseAdmin.from('tracking_events').insert({ shipment_id: shipmentId, status, description: description || defaultDescription(status, courier, trackingNumber) });

  if (status === 'shipped') {
    await notificationService.create(data.orders.buyer_id, {
      type: 'artwork_shipped',
      title: 'Your order has shipped',
      body: `Order ${data.orders.order_number} is on its way${courier ? ` via ${courier}` : ''}.`,
      data: { shipmentId },
    });
  } else if (status === 'delivered') {
    await notificationService.create(data.orders.buyer_id, {
      type: 'artwork_delivered',
      title: 'Your order has been delivered',
      body: `Order ${data.orders.order_number} has been marked delivered.`,
      data: { shipmentId },
    });
    // Delivery is also a natural point to move the order toward completion.
    await supabaseAdmin.from('orders').update({ status: 'delivered' }).eq('id', data.order_id).eq('status', 'shipped');
  }

  return data;
}

/** Buyer requests a return (spec section 23/24 — feeds into the dispute flow for anything beyond a straightforward exchange). */
async function requestReturn(orderId, buyerId, reason) {
  const { data: order } = await supabaseAdmin.from('orders').select('id').eq('id', orderId).eq('buyer_id', buyerId).maybeSingle();
  if (!order) throw new AppError('Order not found.', 404, 'NOT_FOUND');

  const { data: shipment, error } = await supabaseAdmin
    .from('shipments')
    .update({ status: 'return_requested' })
    .eq('order_id', orderId)
    .eq('status', 'delivered')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not request return.', 500, 'UPDATE_FAILED');
  if (!shipment) throw new AppError('Returns can only be requested for delivered orders.', 400, 'INVALID_STATE_TRANSITION');

  await supabaseAdmin.from('tracking_events').insert({ shipment_id: shipment.id, status: 'return_requested', description: reason || 'Buyer requested a return.' });
  return shipment;
}

function defaultDescription(status, courier, trackingNumber) {
  const map = {
    ready_for_shipment: 'Package is ready for pickup.',
    shipped: `Shipped${courier ? ` via ${courier}` : ''}${trackingNumber ? ` (tracking: ${trackingNumber})` : ''}.`,
    in_transit: 'Package is in transit.',
    delivered: 'Package has been delivered.',
    lost: 'Package reported lost in transit.',
    damaged: 'Package reported damaged.',
    returned: 'Package has been returned.',
  };
  return map[status] || `Status updated to ${status}.`;
}

module.exports = { createForOrder, getForOrder, updateStatus, requestReturn };
