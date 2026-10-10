const crypto = require('crypto');
const config = require('../config');
const AppError = require('../utils/AppError');
const { supabaseAdmin } = require('../config/supabase');
const artworkService = require('./artworkService');
const ledgerService = require('./ledgerService');
const certificateService = require('./certificateService');
const shipmentService = require('./shipmentService');
const resaleService = require('./resaleService');

/**
 * PAYMENT ABSTRACTION LAYER
 * ---------------------------------------------------------------------
 * Controllers/services talk to this module, never to a specific
 * provider's SDK directly. Each adapter implements the same four-method
 * interface, so swapping `config.payment.provider` (or adding a new
 * adapter below) never touches order/checkout logic:
 *   initialize(order, { email }) -> { authorizationUrl, providerReference }
 *   verifyTransaction(reference) -> { status: 'success'|'failed'|'pending', raw }
 *   verifyWebhookSignature(rawBody, signatureHeader) -> boolean
 *   parseWebhookEvent(rawBody) -> { eventId, providerReference, status, raw }
 *
 * Two real adapters are wired up below (Paystack, Stripe) as proof the
 * abstraction actually holds — not just a comment promising it would.
 */

function toSubunit(amount) {
  // All four supported currencies (NGN, USD, GBP, EUR) use 2-decimal
  // subunits (kobo/cents/pence). A zero-decimal currency (e.g. JPY) would
  // need its own branch here if ever added to `currencies`.
  return Math.round(Number(amount) * 100);
}

async function providerFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.message || json.error?.message || `Payment provider request failed (${res.status}).`;
    throw new AppError(message, 502, 'PROVIDER_ERROR');
  }
  return json;
}

const providers = {
  // -------------------------------------------------------------------
  // PAYSTACK — https://paystack.com/docs/api/transaction
  // -------------------------------------------------------------------
  paystack: {
    async initialize(order, { email }) {
      const reference = `artelia_${order.order_number}_${crypto.randomBytes(4).toString('hex')}`;

      const json = await providerFetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.payment.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          amount: toSubunit(order.total_amount),
          currency: order.currency,
          reference,
          callback_url: `${config.frontendUrl}/order-status.html?order=${order.id}`,
          metadata: { order_id: order.id, order_number: order.order_number },
        }),
      });

      if (!json.status) throw new AppError(json.message || 'Could not initialize payment.', 502, 'PROVIDER_ERROR');
      return { authorizationUrl: json.data.authorization_url, providerReference: json.data.reference };
    },

    async verifyTransaction(reference) {
      const json = await providerFetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${config.payment.secretKey}` },
      });
      const paystackStatus = json.data?.status; // 'success' | 'failed' | 'abandoned' | ...
      const status = paystackStatus === 'success' ? 'success' : paystackStatus === 'abandoned' ? 'pending' : 'failed';
      return { status, raw: json.data };
    },

    // Paystack signs webhooks with the INTEGRATION SECRET KEY itself
    // (not a separate webhook secret) — see their docs on x-paystack-signature.
    verifyWebhookSignature(rawBody, signatureHeader) {
      if (!signatureHeader) return false;
      const hash = crypto.createHmac('sha512', config.payment.secretKey).update(rawBody).digest('hex');
      return timingSafeEqualHex(hash, signatureHeader);
    },

    parseWebhookEvent(rawBody) {
      const payload = JSON.parse(rawBody);
      let status = 'ignored';
      if (payload.event === 'charge.success') status = 'success';
      else if (payload.event === 'charge.failed') status = 'failed';

      return {
        eventId: payload.data?.id?.toString() || payload.data?.reference,
        providerReference: payload.data?.reference,
        status,
        raw: payload,
      };
    },

    async refund(reference, amount) {
      const json = await providerFetch('https://api.paystack.co/refund', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.payment.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: reference, amount: toSubunit(amount) }),
      });
      if (!json.status) throw new AppError(json.message || 'Refund could not be processed.', 502, 'PROVIDER_ERROR');
      return { providerReference: json.data?.id?.toString() || reference };
    },
  },

  // -------------------------------------------------------------------
  // STRIPE — https://stripe.com/docs/api/checkout/sessions
  // -------------------------------------------------------------------
  stripe: {
    async initialize(order, { email }) {
      const params = new URLSearchParams();
      params.set('mode', 'payment');
      params.set('success_url', `${config.frontendUrl}/order-status.html?order=${order.id}&session_id={CHECKOUT_SESSION_ID}`);
      params.set('cancel_url', `${config.frontendUrl}/cart.html`);
      params.set('customer_email', email);
      params.set('metadata[order_id]', order.id);
      params.set('metadata[order_number]', order.order_number);
      params.set('payment_method_types[0]', 'card');
      params.set('line_items[0][quantity]', '1');
      params.set('line_items[0][price_data][currency]', order.currency.toLowerCase());
      params.set('line_items[0][price_data][unit_amount]', String(toSubunit(order.total_amount)));
      params.set('line_items[0][price_data][product_data][name]', `ARTELIA Order ${order.order_number}`);

      const json = await providerFetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.payment.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      return { authorizationUrl: json.url, providerReference: json.id };
    },

    async verifyTransaction(reference) {
      const json = await providerFetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${config.payment.secretKey}` },
      });
      const status = json.payment_status === 'paid' ? 'success' : json.status === 'expired' ? 'failed' : 'pending';
      return { status, raw: json };
    },

    // Stripe's documented scheme: header is "t=<timestamp>,v1=<signature>";
    // signature is HMAC-SHA256 of "<timestamp>.<rawBody>" using the webhook secret.
    verifyWebhookSignature(rawBody, signatureHeader) {
      if (!signatureHeader) return false;
      const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=')));
      if (!parts.t || !parts.v1) return false;

      const signedPayload = `${parts.t}.${rawBody}`;
      const expected = crypto.createHmac('sha256', config.payment.webhookSecret).update(signedPayload).digest('hex');
      return timingSafeEqualHex(expected, parts.v1);
    },

    parseWebhookEvent(rawBody) {
      const payload = JSON.parse(rawBody);
      let status = 'ignored';
      if (payload.type === 'checkout.session.completed') status = 'success';
      else if (payload.type === 'checkout.session.expired') status = 'failed';

      return {
        eventId: payload.id,
        providerReference: payload.data?.object?.id,
        status,
        raw: payload,
      };
    },

    async refund(sessionId, amount) {
      const session = await providerFetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${config.payment.secretKey}` },
      });
      if (!session.payment_intent) throw new AppError('Could not resolve the original payment for refund.', 502, 'PROVIDER_ERROR');

      const params = new URLSearchParams();
      params.set('payment_intent', session.payment_intent);
      params.set('amount', String(toSubunit(amount)));

      const json = await providerFetch('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.payment.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      return { providerReference: json.id };
    },
  },
};

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getProvider(providerName = config.payment.provider) {
  const provider = providers[providerName];
  if (!provider) throw new AppError('Payment provider not configured.', 500, 'PROVIDER_NOT_CONFIGURED');
  return provider;
}

/**
 * Creates a payment intent record and returns the URL the frontend
 * should redirect the buyer to. Never returns provider secret keys.
 */
async function initiatePayment(order) {
  const provider = getProvider();

  const { data: buyer } = await supabaseAdmin.from('users').select('email').eq('id', order.buyer_id).single();
  if (!buyer) throw new AppError('Could not resolve buyer for payment.', 500, 'PAYMENT_INIT_FAILED');

  const idempotencyKey = `order-${order.id}`; // one payment attempt record per order

  const { data: existing } = await supabaseAdmin
    .from('payments')
    .select('id, provider_reference, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'pending' || existing.status === 'processing') {
      // Re-checkout of a still-open attempt: hand back a fresh redirect
      // rather than erroring, since the buyer may have simply closed the tab.
      throw new AppError('A payment for this order is already in progress. Please check your order status.', 409, 'PAYMENT_ALREADY_INITIATED');
    }
    throw new AppError('A payment for this order has already been completed or failed.', 409, 'PAYMENT_ALREADY_INITIATED');
  }

  const { authorizationUrl, providerReference } = await provider.initialize(order, { email: buyer.email });

  const { error } = await supabaseAdmin.from('payments').insert({
    order_id: order.id,
    provider: config.payment.provider,
    provider_reference: providerReference,
    amount: order.total_amount,
    currency: order.currency,
    status: 'pending',
    idempotency_key: idempotencyKey,
  });

  if (error) throw new AppError('Could not initiate payment.', 500, 'PAYMENT_INIT_FAILED');

  return { authorizationUrl };
}

/**
 * Processes an incoming webhook. This is the primary place payment
 * success is trusted from — never a frontend "I paid!" callback. Guards
 * against duplicate delivery (providers retry) via the webhook_event_id
 * unique constraint, and against signature forgery via verifyWebhookSignature.
 */
async function handleWebhook(rawBody, signatureHeader) {
  const provider = getProvider();

  if (!provider.verifyWebhookSignature(rawBody, signatureHeader)) {
    throw new AppError('Invalid webhook signature.', 401, 'INVALID_SIGNATURE');
  }

  const event = provider.parseWebhookEvent(rawBody);
  if (event.status === 'ignored') return { alreadyProcessed: true, ignored: true };

  const { data: payment, error: findErr } = await supabaseAdmin
    .from('payments')
    .select('*, orders(*)')
    .eq('provider_reference', event.providerReference)
    .maybeSingle();

  if (findErr || !payment) throw new AppError('Payment record not found for this event.', 404, 'NOT_FOUND');

  return finalizeFromEvent(payment, event);
}

/**
 * Manual verification path (spec section 51-adjacent): called when the
 * buyer lands back on our success page, or by the reconciliation job.
 * Queries the provider directly rather than trusting anything the
 * browser carried back in the URL — the webhook remains the primary
 * confirmation path, this is defense in depth for the gap between
 * "buyer returned" and "webhook arrived."
 */
async function verifyAndFinalize(orderId, buyerId) {
  const { data: payment, error } = await supabaseAdmin
    .from('payments')
    .select('*, orders!inner(*)')
    .eq('order_id', orderId)
    .eq('orders.buyer_id', buyerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !payment) throw new AppError('No payment found for this order.', 404, 'NOT_FOUND');
  if (payment.status === 'success') return { status: 'success', order: payment.orders };

  const provider = getProvider(payment.provider);
  const result = await provider.verifyTransaction(payment.provider_reference);

  const outcome = await finalizeFromEvent(payment, {
    eventId: `manual-verify-${Date.now()}`,
    providerReference: payment.provider_reference,
    status: result.status,
    raw: result.raw,
  });

  return { status: outcome.success ? 'success' : result.status, order: payment.orders };
}

/** Shared finalize logic used by both the webhook handler and manual verification. */
async function finalizeFromEvent(payment, event) {
  // Idempotency / duplicate-event guard.
  if (payment.webhook_event_id === event.eventId) return { alreadyProcessed: true };
  if (payment.status === 'success') {
    await supabaseAdmin.from('payments').update({ webhook_event_id: event.eventId }).eq('id', payment.id);
    return { alreadyProcessed: true, success: true };
  }

  if (event.status === 'pending') {
    return { alreadyProcessed: false, success: false, pending: true };
  }

  await supabaseAdmin
    .from('payments')
    .update({ status: event.status, webhook_event_id: event.eventId, raw_provider_payload: event.raw })
    .eq('id', payment.id);

  if (event.status !== 'success') {
    await supabaseAdmin.from('orders').update({ status: 'payment_processing' }).eq('id', payment.order_id);
    return { alreadyProcessed: false, success: false };
  }

  // ---- Payment confirmed: finalize the order atomically ----
  const order = payment.orders;

  const { data: orderItems } = await supabaseAdmin
    .from('order_items')
    .select('*, artist_profiles!inner(user_id)')
    .eq('order_id', order.id);

  // Each line item is either an artwork sale or a commission payment
  // (order_items.artwork_id is nullable specifically for the latter —
  // see phase7_schema.sql). Only artwork items get marked sold,
  // certificated, and given a provenance record; a commission payment
  // instead nudges the commission's own workflow forward.
  for (const item of orderItems) {
    if (item.artwork_id) {
      await artworkService.markSold(item.artwork_id, order.id);
    }
  }

  // Resale items (Phase 9, spec section 40) post different ledger
  // entries — seller earning + optional artist royalty, never the usual
  // "artist_earning" — so they're excluded from the normal sale posting
  // and handled by resaleService below instead.
  const firstSaleItems = orderItems.filter((i) => !i.resale_listing_id);
  const resaleItems = orderItems.filter((i) => i.resale_listing_id);

  if (firstSaleItems.length) {
    await ledgerService.postSaleEntries({
      order,
      orderItems: firstSaleItems.map((i) => ({ ...i, artist_user_id: i.artist_profiles.user_id })),
      paymentId: payment.id,
    });
  }

  await supabaseAdmin.from('orders').update({ status: 'paid' }).eq('id', order.id);

  let hasPhysicalItem = false;
  for (const item of resaleItems) {
    hasPhysicalItem = true;
    await resaleService.finalizeResale(item, order);
  }

  for (const item of firstSaleItems) {
    if (item.artwork_id) {
      hasPhysicalItem = true;
      await certificateService.issue(item.artwork_id, order.id, order.buyer_id);
    } else if (item.commission_id) {
      // Deposit/payment received — work can now begin. Only advances
      // from 'accepted'; if the artist already moved it further along
      // some other way, this leaves that status alone.
      await supabaseAdmin.from('commissions').update({ status: 'in_progress' }).eq('id', item.commission_id).eq('status', 'accepted');
    }
  }

  if (hasPhysicalItem) {
    await shipmentService.createForOrder(order.id);
  }

  return { alreadyProcessed: false, success: true };
}

/**
 * Issues a refund through the provider's API, then posts the matching
 * reversal ledger entries (spec sections 24, 26): the platform's
 * original payment-receipt and commission entries are reversed, and the
 * artist's earning is reversed too, proportionally for a partial refund.
 * Called exclusively from disputeService's resolution path — a refund
 * always has a documented reason, never a bare balance adjustment.
 */
async function issueRefund(orderId, amount, reason, disputeId) {
  const { data: payment, error } = await supabaseAdmin
    .from('payments')
    .select('*, orders(*)')
    .eq('order_id', orderId)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !payment) throw new AppError('No successful payment found for this order.', 404, 'NOT_FOUND');

  const refundAmount = round2(Math.min(Number(amount), Number(payment.amount)));
  if (refundAmount <= 0) throw new AppError('Refund amount must be greater than zero.', 422, 'VALIDATION_ERROR');

  const provider = getProvider(payment.provider);
  let providerReference = null;
  if (typeof provider.refund === 'function') {
    const result = await provider.refund(payment.provider_reference, refundAmount);
    providerReference = result.providerReference;
  } else {
    console.warn(`[paymentService] Provider '${payment.provider}' has no refund() adapter — recording the refund without an automatic provider-side transfer. Process it manually and attach the reference.`);
  }

  const { data: refund, error: refundErr } = await supabaseAdmin
    .from('refunds')
    .insert({
      payment_id: payment.id,
      order_id: orderId,
      amount: refundAmount,
      reason,
      status: providerReference ? 'success' : 'pending',
      provider_reference: providerReference,
      dispute_id: disputeId || null,
    })
    .select('*')
    .single();

  if (refundErr) throw new AppError('Could not record refund.', 500, 'CREATE_FAILED');

  await postRefundLedgerEntries(payment, refundAmount);

  const isFullRefund = refundAmount >= Number(payment.amount) - 0.01;
  await supabaseAdmin.from('orders').update({ status: isFullRefund ? 'refunded' : 'refund_pending' }).eq('id', orderId);
  await supabaseAdmin.from('payments').update({ status: isFullRefund ? 'refunded' : 'partially_refunded' }).eq('id', payment.id);

  return refund;
}

/**
 * Reverses the sale's ledger entries proportionally to the refund
 * amount: the platform gives back what it received and its commission
 * cut, and the artist's earning is clawed back by the same proportion —
 * never by deleting or editing the original entries (spec section 26).
 */
async function postRefundLedgerEntries(payment, refundAmount) {
  const { data: orderItems } = await supabaseAdmin
    .from('order_items')
    .select('*, artist_profiles!inner(user_id)')
    .eq('order_id', payment.order_id);

  const orderTotal = orderItems.reduce((sum, i) => sum + Number(i.unit_price), 0);
  const refundRatio = orderTotal > 0 ? refundAmount / orderTotal : 0;

  const platformAccount = await ledgerService.getOrCreateAccount('platform', null, payment.currency);

  for (const item of orderItems) {
    const itemRefundPortion = round2(Number(item.unit_price) * refundRatio);
    if (itemRefundPortion <= 0) continue;

    const commissionPortion = round2((itemRefundPortion * Number(item.commission_rate)) / 100);
    const artistPortion = round2(itemRefundPortion - commissionPortion);

    await ledgerService.insertEntry({
      reference: `REFUND-${payment.id}`, ledgerAccountId: platformAccount.id, entryType: 'refund', direction: 'debit',
      amount: itemRefundPortion, currency: payment.currency, relatedOrderId: payment.order_id, relatedArtworkId: item.artwork_id,
    });

    const artistAccount = await ledgerService.getOrCreateAccount('artist', item.artist_id, payment.currency);
    await ledgerService.insertEntry({
      reference: `REFUND-${payment.id}`, ledgerAccountId: artistAccount.id, entryType: 'refund', direction: 'debit',
      amount: artistPortion, currency: payment.currency, relatedOrderId: payment.order_id, relatedArtworkId: item.artwork_id,
      relatedUserId: item.artist_profiles.user_id,
    });

    // Clawed back from whichever balance currently holds it — pending if
    // the buyer-protection window hasn't elapsed, available if it has.
    const fromPending = Math.min(artistPortion, Number(artistAccount.pending_balance));
    const fromAvailable = artistPortion - fromPending;
    await supabaseAdmin
      .from('ledger_accounts')
      .update({
        pending_balance: Math.max(0, Number(artistAccount.pending_balance) - fromPending),
        available_balance: Math.max(0, Number(artistAccount.available_balance) - fromAvailable),
      })
      .eq('id', artistAccount.id);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { initiatePayment, handleWebhook, verifyAndFinalize, getProvider, finalizeFromEvent, issueRefund };
