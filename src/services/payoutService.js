const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const ledgerService = require('./ledgerService');
const feeService = require('./feeService');
const payoutProviderService = require('./payoutProviderService');

/**
 * PAYOUT / WITHDRAWAL SERVICE
 * ---------------------------------------------------------------------
 * Pulled forward from Phase 5 because the fee-management system needs a
 * real "withdrawal" gateway to integrate with. Full payout-provider
 * integration (actually wiring a bank transfer API) still belongs to
 * Phase 5 — this covers the request -> fee -> ledger -> pending-payout
 * pipeline, which is the part that must be correct from day one.
 *
 * FEE GATEWAY: "withdrawal" — if admin has an active withdrawal fee
 * configured, it is deducted from the requested amount automatically
 * and settled immediately via balance deduction. If no fee is
 * configured, the full amount proceeds to payout with nothing owed.
 */

async function requestPayout(artistProfileId, userId, { amount, currency }) {
  if (amount <= 0) throw new AppError('Withdrawal amount must be greater than zero.', 422, 'VALIDATION_ERROR');

  const account = await ledgerService.getOrCreateAccount('artist', artistProfileId, currency);
  if (Number(account.available_balance) < Number(amount)) {
    throw new AppError('Withdrawal amount exceeds your available balance.', 400, 'INSUFFICIENT_BALANCE');
  }

  // Create the payout row first (status 'pending', amount = gross for now)
  // so the fee charge below has a stable, per-request unique entity to
  // attach to — using the artist's own ID here would incorrectly dedupe
  // separate withdrawal requests against each other in feeService's
  // "reuse an existing charge for this entity" check.
  const { data: payout, error: createErr } = await supabaseAdmin
    .from('payouts')
    .insert({ artist_id: artistProfileId, amount, currency, status: 'pending' })
    .select('*')
    .single();

  if (createErr) throw new AppError('Could not create payout request.', 500, 'CREATE_FAILED');

  // FEE GATEWAY: "withdrawal" — resolved and settled (if configured)
  // against this specific payout request, immediately via balance
  // deduction since the artist's own balance is the natural source.
  const feeCharge = await feeService.getOrCreateCharge({
    feeTypeCode: 'withdrawal',
    userId,
    relatedEntityType: 'payout_request',
    relatedEntityId: payout.id,
    baseAmount: amount,
    currency,
  });

  let feeAmount = 0;
  if (feeCharge && !feeService.isSettled(feeCharge)) {
    const settled = await feeService.settleByBalanceDeduction(feeCharge.id, userId, artistProfileId);
    feeAmount = Number(settled.amount);
  } else if (feeCharge) {
    feeAmount = Number(feeCharge.amount);
  }

  const netAmount = round2(Number(amount) - feeAmount);
  if (netAmount <= 0) {
    // Roll back the draft payout row entirely — nothing should be owed or held.
    await supabaseAdmin.from('payouts').delete().eq('id', payout.id);
    throw new AppError('The withdrawal fee equals or exceeds the requested amount.', 400, 'INVALID_AMOUNT');
  }

  // Re-fetch balance since the fee settlement above may have just debited it.
  const refreshedAccount = await ledgerService.getOrCreateAccount('artist', artistProfileId, currency);
  if (Number(refreshedAccount.available_balance) < netAmount) {
    await supabaseAdmin.from('payouts').delete().eq('id', payout.id);
    throw new AppError('Insufficient available balance after fees.', 400, 'INSUFFICIENT_BALANCE');
  }

  // Debit the NET withdrawal amount from available balance immediately —
  // funds are committed the moment a payout is requested, so they can't
  // be withdrawn twice while the request is pending processing.
  await supabaseAdmin
    .from('ledger_accounts')
    .update({ available_balance: Number(refreshedAccount.available_balance) - netAmount })
    .eq('id', refreshedAccount.id);

  const { data: finalizedPayout, error: updateErr } = await supabaseAdmin
    .from('payouts')
    .update({ amount: netAmount })
    .eq('id', payout.id)
    .select('*')
    .single();

  if (updateErr) throw new AppError('Could not finalize payout amount.', 500, 'UPDATE_FAILED');

  await ledgerService.insertEntry({
    reference: payout.id,
    ledgerAccountId: refreshedAccount.id,
    entryType: 'payout',
    direction: 'debit',
    amount: netAmount,
    currency,
    relatedUserId: userId,
  });

  return { payout: finalizedPayout, feeCharged: feeAmount, grossAmount: Number(amount) };
}

async function listMine(artistProfileId) {
  const { data, error } = await supabaseAdmin.from('payouts').select('*').eq('artist_id', artistProfileId).order('requested_at', { ascending: false });
  if (error) throw new AppError('Could not load payouts.', 500, 'QUERY_FAILED');
  return data;
}

async function listAll({ status, page = 1, pageSize = 30 } = {}) {
  let query = supabaseAdmin
    .from('payouts')
    .select('*, artist_profiles(artist_name, slug, user_id)', { count: 'exact' })
    .order('requested_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load payouts.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

/**
 * Admin-triggered real transfer via the payout provider (Paystack
 * Transfers). Resolves/creates the transfer recipient from the artist's
 * saved bank details, initiates the transfer, and moves the payout to
 * 'processing' with the provider's reference attached — final
 * confirmation arrives via handleTransferWebhook (or a manual
 * markProcessed/markFailed call if the provider integration isn't
 * fully configured yet in this environment).
 */
async function initiateProviderTransfer(payoutId) {
  const { data: payout, error } = await supabaseAdmin.from('payouts').select('*').eq('id', payoutId).eq('status', 'pending').single();
  if (error || !payout) throw new AppError('Only pending payouts can have a transfer initiated.', 400, 'INVALID_STATE_TRANSITION');

  const { data: payoutAccount } = await supabaseAdmin
    .from('artist_payout_accounts')
    .select('*')
    .eq('artist_id', payout.artist_id)
    .maybeSingle();

  if (!payoutAccount) throw new AppError('This artist has no payout bank account on file.', 400, 'PAYOUT_ACCOUNT_MISSING');

  const provider = payoutProviderService.getPayoutProvider();
  const { recipientCode } = await provider.ensureRecipient(payoutAccount);

  if (recipientCode !== payoutAccount.provider_recipient_code) {
    await supabaseAdmin.from('artist_payout_accounts').update({ provider_recipient_code: recipientCode }).eq('id', payoutAccount.id);
  }

  const reference = `payout_${payout.id}`;
  const result = await provider.sendTransfer(recipientCode, payout.amount, payout.currency, reference, `ARTELIA withdrawal ${payout.id}`);

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('payouts')
    .update({
      status: result.status === 'success' ? 'success' : 'processing',
      provider_reference: result.providerReference,
      processed_at: result.status === 'success' ? new Date().toISOString() : null,
    })
    .eq('id', payoutId)
    .select('*')
    .single();

  if (updateErr) throw new AppError('Transfer was sent but the payout record could not be updated — check provider dashboard.', 500, 'UPDATE_FAILED');
  return updated;
}

/**
 * Confirms or reverses a provider-initiated transfer based on the
 * provider's webhook — the ONLY place a 'processing' payout is
 * trusted to have actually succeeded or failed, mirroring how payment
 * webhooks are the source of truth for order payments.
 */
async function handleTransferWebhook(rawBody, signatureHeader) {
  const provider = payoutProviderService.getPayoutProvider();

  if (!provider.verifyWebhookSignature(rawBody, signatureHeader)) {
    throw new AppError('Invalid webhook signature.', 401, 'INVALID_SIGNATURE');
  }

  const event = provider.parseWebhookEvent(rawBody);
  if (event.status === 'ignored') return { processed: false };

  const { data: payout } = await supabaseAdmin.from('payouts').select('*').eq('provider_reference', event.providerReference).maybeSingle();
  if (!payout) return { processed: false }; // not one of ours, or already resolved

  if (event.status === 'success' && payout.status !== 'success') {
    await supabaseAdmin.from('payouts').update({ status: 'success', processed_at: new Date().toISOString() }).eq('id', payout.id);
    return { processed: true, outcome: 'success' };
  }

  if ((event.status === 'failed' || event.status === 'reversed') && payout.status !== 'failed') {
    await markFailed(payout.id, `Provider reported: ${event.status}`);
    return { processed: true, outcome: event.status };
  }

  return { processed: false };
}

/** Admin marks a payout as processed successfully — a manual fallback for providers/flows not fully automated yet. */
async function markProcessed(payoutId, providerReference) {
  const { data, error } = await supabaseAdmin
    .from('payouts')
    .update({ status: 'success', processed_at: new Date().toISOString(), provider_reference: providerReference })
    .eq('id', payoutId)
    .in('status', ['pending', 'processing'])
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update payout.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only pending or processing payouts can be marked processed.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

/** Admin marks a payout as failed — reverses the ledger debit so the artist isn't out the funds. */
async function markFailed(payoutId, reason) {
  const { data: payout, error: fetchErr } = await supabaseAdmin.from('payouts').select('*').eq('id', payoutId).in('status', ['pending', 'processing']).single();
  if (fetchErr || !payout) throw new AppError('Only pending or processing payouts can be marked failed.', 400, 'INVALID_STATE_TRANSITION');

  const account = await ledgerService.getOrCreateAccount('artist', payout.artist_id, payout.currency);
  await supabaseAdmin
    .from('ledger_accounts')
    .update({ available_balance: Number(account.available_balance) + Number(payout.amount) })
    .eq('id', account.id);

  await ledgerService.insertEntry({
    reference: `${payout.id}-REVERSAL`,
    ledgerAccountId: account.id,
    entryType: 'adjustment',
    direction: 'credit',
    amount: payout.amount,
    currency: payout.currency,
  });

  const { data, error } = await supabaseAdmin
    .from('payouts')
    .update({ status: 'failed', failure_reason: reason })
    .eq('id', payoutId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not update payout.', 500, 'UPDATE_FAILED');
  return data;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { requestPayout, listMine, listAll, initiateProviderTransfer, handleTransferWebhook, markProcessed, markFailed };
