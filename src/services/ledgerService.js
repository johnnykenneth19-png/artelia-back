const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * LEDGER SERVICE
 * ---------------------------------------------------------------------
 * This is the ONLY code path allowed to write to ledger_entries or
 * mutate ledger_accounts balances. Controllers/other services must
 * never update a balance column directly — every balance change is
 * derived from an immutable entry so the system stays reconcilable.
 *
 * NOTE ON TRANSACTIONS: supabase-js does not expose multi-statement
 * client-side transactions. In production, the block below should be
 * a single Postgres function (see database/functions.sql, Phase 5)
 * called via supabaseAdmin.rpc('post_sale_ledger_entries', {...}) so
 * the balance update and entry inserts are atomic. The JS shown here
 * mirrors that function's logic for readability during development —
 * swap the marked section for the RPC call before going to production.
 */

async function getOrCreateAccount(ownerType, ownerId, currency) {
  const { data: existing } = await supabaseAdmin
    .from('ledger_accounts')
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .eq('currency', currency)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabaseAdmin
    .from('ledger_accounts')
    .insert({ owner_type: ownerType, owner_id: ownerId, currency })
    .select('*')
    .single();

  if (error) throw new AppError('Could not initialize ledger account.', 500, 'LEDGER_ERROR');
  return created;
}

/**
 * Resolves the commission rate that applies to a given artwork at the
 * moment of sale, in priority order: artist-specific > category-specific
 * > active promotion > global default. Never hard-code a rate inline
 * anywhere else in the codebase.
 */
async function resolveCommissionRate({ artistId, categoryId }) {
  const nowIso = new Date().toISOString();

  const { data: rules } = await supabaseAdmin
    .from('commission_rules')
    .select('*')
    .eq('is_active', true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`);

  const artistRule = rules?.find((r) => r.scope === 'artist' && r.artist_id === artistId);
  if (artistRule?.percentage != null) return artistRule.percentage;

  const categoryRule = rules?.find((r) => r.scope === 'category' && r.category_id === categoryId);
  if (categoryRule?.percentage != null) return categoryRule.percentage;

  const promoRule = rules?.find((r) => r.scope === 'promotion');
  if (promoRule?.percentage != null) return promoRule.percentage;

  const config = require('../config');
  return config.platform.defaultCommissionPercentage;
}

/**
 * Posts the full set of ledger entries for a successful sale:
 *   - payment received (platform account, credit)
 *   - platform commission (platform account, credit)
 *   - artist earning (artist account, credit — lands in PENDING balance
 *     until the buyer-protection hold period elapses, see payoutService)
 * Called exclusively from the payment webhook handler, exactly once per
 * payment, guarded by the payments.webhook_event_id unique constraint.
 */
async function postSaleEntries({ order, orderItems, paymentId }) {
  const platformAccount = await getOrCreateAccount('platform', null, order.currency);

  for (const item of orderItems) {
    const commissionAmount = round2((item.unit_price * item.commission_rate) / 100);
    const artistEarning = round2(item.unit_price - commissionAmount);

    const artistAccount = await getOrCreateAccount('artist', item.artist_id, order.currency);

    // Platform receives the full payment amount for this item.
    await insertEntry({
      reference: order.order_number,
      ledgerAccountId: platformAccount.id,
      entryType: 'payment',
      direction: 'credit',
      amount: item.unit_price,
      currency: order.currency,
      relatedOrderId: order.id,
      relatedArtworkId: item.artwork_id,
    });

    // Platform keeps the commission slice.
    await insertEntry({
      reference: order.order_number,
      ledgerAccountId: platformAccount.id,
      entryType: 'platform_commission',
      direction: 'credit',
      amount: commissionAmount,
      currency: order.currency,
      relatedOrderId: order.id,
      relatedArtworkId: item.artwork_id,
    });

    // Artist earns the remainder — posted to PENDING, not available,
    // until the protection window passes (payoutService promotes it).
    await insertEntry({
      reference: order.order_number,
      ledgerAccountId: artistAccount.id,
      entryType: 'artist_earning',
      direction: 'credit',
      amount: artistEarning,
      currency: order.currency,
      relatedOrderId: order.id,
      relatedArtworkId: item.artwork_id,
      relatedUserId: item.artist_user_id,
    });

    await supabaseAdmin
      .from('ledger_accounts')
      .update({ pending_balance: artistAccount.pending_balance + artistEarning })
      .eq('id', artistAccount.id);
  }
}

async function insertEntry({
  reference, ledgerAccountId, entryType, direction, amount, currency,
  relatedOrderId = null, relatedArtworkId = null, relatedUserId = null,
}) {
  if (amount <= 0) throw new AppError('Ledger amount must be positive.', 500, 'LEDGER_ERROR');

  const { error } = await supabaseAdmin.from('ledger_entries').insert({
    reference,
    ledger_account_id: ledgerAccountId,
    entry_type: entryType,
    direction,
    amount,
    currency,
    related_order_id: relatedOrderId,
    related_artwork_id: relatedArtworkId,
    related_user_id: relatedUserId,
  });

  if (error) throw new AppError('Failed to record financial transaction.', 500, 'LEDGER_ERROR');
}

/**
 * Reverses a prior entry by inserting a new opposite-direction entry
 * that references the original. The original row is never touched.
 */
async function reverseEntry(originalEntryId, reason) {
  const { data: original, error } = await supabaseAdmin
    .from('ledger_entries')
    .select('*')
    .eq('id', originalEntryId)
    .single();

  if (error || !original) throw new AppError('Original ledger entry not found.', 404, 'NOT_FOUND');

  const oppositeDirection = original.direction === 'credit' ? 'debit' : 'credit';

  await supabaseAdmin.from('ledger_entries').insert({
    reference: `${original.reference}-REVERSAL`,
    ledger_account_id: original.ledger_account_id,
    entry_type: 'adjustment',
    direction: oppositeDirection,
    amount: original.amount,
    currency: original.currency,
    related_order_id: original.related_order_id,
    related_artwork_id: original.related_artwork_id,
    related_user_id: original.related_user_id,
    reversal_of_entry_id: original.id,
  });

  await supabaseAdmin.from('ledger_entries').update({ status: 'reversed' }).eq('id', original.id);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { getOrCreateAccount, resolveCommissionRate, postSaleEntries, insertEntry, reverseEntry };
