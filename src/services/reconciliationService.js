const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const paymentService = require('./paymentService');

/**
 * RECONCILIATION SERVICE (spec section 51)
 * ---------------------------------------------------------------------
 * Compares: internal payment records <-> provider records <-> order
 * records. Never auto-"fixes" a financial discrepancy — it either
 * finalizes a payment using the exact same guarded, idempotent path a
 * webhook would (safe to do automatically, since it's just catching up
 * on what should have already happened), or it flags anything it can't
 * resolve that way for a human to investigate.
 *
 * Intended to run on a schedule (external cron/worker) via
 * reconcilePendingPayments() — see src/jobs/ for a runnable entry point.
 * Nothing in this codebase invokes it automatically.
 */

const STALE_AFTER_MINUTES = 10;

/**
 * Sweeps payments stuck in 'pending'/'processing' past a grace period
 * (the buyer may have abandoned checkout, or a webhook may have been
 * missed) and asks the provider directly what actually happened.
 */
async function reconcilePendingPayments({ batchSize = 50 } = {}) {
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();

  const { data: stalePayments, error } = await supabaseAdmin
    .from('payments')
    .select('*, orders(*)')
    .in('status', ['pending', 'processing'])
    .lt('created_at', staleCutoff)
    .limit(batchSize);

  if (error) throw new AppError('Could not load payments for reconciliation.', 500, 'QUERY_FAILED');

  const summary = { checked: 0, finalizedSuccess: 0, finalizedFailed: 0, stillPending: 0, flagged: 0, providerErrors: 0 };

  for (const payment of stalePayments) {
    summary.checked++;
    try {
      const provider = paymentService.getProvider(payment.provider);
      const result = await provider.verifyTransaction(payment.provider_reference);

      // Amount/currency mismatch between what we recorded and what the
      // provider confirms — flagged, never silently trusted either way.
      if (result.raw && typeof result.raw.amount === 'number') {
        const providerAmount = result.raw.amount / 100; // provider returns subunits
        const expectedAmount = Number(payment.amount);
        if (Math.abs(providerAmount - expectedAmount) > 0.01) {
          await createFlag({
            paymentId: payment.id,
            orderId: payment.order_id,
            issueType: 'amount_mismatch',
            details: { expected: expectedAmount, providerReported: providerAmount, currency: payment.currency },
          });
          summary.flagged++;
        }
      }

      const outcome = await paymentService.finalizeFromEvent(payment, {
        eventId: `reconcile-${payment.id}-${Date.now()}`,
        providerReference: payment.provider_reference,
        status: result.status,
        raw: result.raw,
      });

      if (outcome.success) summary.finalizedSuccess++;
      else if (outcome.pending) summary.stillPending++;
      else summary.finalizedFailed++;
    } catch (err) {
      summary.providerErrors++;
      await createFlag({
        paymentId: payment.id,
        orderId: payment.order_id,
        issueType: 'provider_unreachable',
        details: { message: err.message },
      });
    }
  }

  return summary;
}

/**
 * Sweeps payments already marked 'success' locally and checks the order
 * actually reached a finalized state (paid or beyond). Catches the case
 * where a webhook set payment status but a later finalization step
 * (artwork marking, ledger posting) failed partway — a bug class this
 * can't fix automatically, only surface loudly.
 */
async function reconcileFinalizedOrders({ batchSize = 50 } = {}) {
  const { data: successPayments, error } = await supabaseAdmin
    .from('payments')
    .select('*, orders(*)')
    .eq('status', 'success')
    .limit(batchSize);

  if (error) throw new AppError('Could not load payments for reconciliation.', 500, 'QUERY_FAILED');

  const finalizedStatuses = ['paid', 'processing', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered', 'completed'];
  let flagged = 0;

  for (const payment of successPayments) {
    if (!payment.orders || finalizedStatuses.includes(payment.orders.status)) continue;

    const { data: existingFlag } = await supabaseAdmin
      .from('reconciliation_flags')
      .select('id')
      .eq('payment_id', payment.id)
      .eq('issue_type', 'order_not_finalized')
      .eq('status', 'open')
      .maybeSingle();

    if (existingFlag) continue; // don't spam duplicate flags on repeated sweeps

    await createFlag({
      paymentId: payment.id,
      orderId: payment.order_id,
      issueType: 'order_not_finalized',
      details: { orderStatus: payment.orders.status, paymentStatus: payment.status },
    });
    flagged++;
  }

  return { checked: successPayments.length, flagged };
}

async function createFlag({ paymentId, orderId, issueType, details }) {
  await supabaseAdmin.from('reconciliation_flags').insert({
    payment_id: paymentId, order_id: orderId, issue_type: issueType, details,
  });
}

async function listFlags({ status = 'open', page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from('reconciliation_flags')
    .select('*, payments(provider, provider_reference, amount, currency, status), orders(order_number, status)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load reconciliation flags.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function resolveFlag(flagId, adminUserId, notes) {
  const { data, error } = await supabaseAdmin
    .from('reconciliation_flags')
    .update({ status: 'resolved', resolved_by: adminUserId, resolved_at: new Date().toISOString(), resolution_notes: notes })
    .eq('id', flagId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not update flag.', 500, 'UPDATE_FAILED');
  return data;
}

async function dismissFlag(flagId, adminUserId, notes) {
  const { data, error } = await supabaseAdmin
    .from('reconciliation_flags')
    .update({ status: 'dismissed', resolved_by: adminUserId, resolved_at: new Date().toISOString(), resolution_notes: notes })
    .eq('id', flagId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not update flag.', 500, 'UPDATE_FAILED');
  return data;
}

module.exports = { reconcilePendingPayments, reconcileFinalizedOrders, listFlags, resolveFlag, dismissFlag };
