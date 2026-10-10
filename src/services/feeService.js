const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const ledgerService = require('./ledgerService');

/**
 * FEE MANAGEMENT SERVICE
 * ---------------------------------------------------------------------
 * Every fee-charging action in ARTELIA (uploading/listing artwork,
 * withdrawing funds, paying for an order, requesting a commission, etc.)
 * goes through this module rather than hard-coding an amount. Admin
 * configures fee_types + fee_rules (see database/fees_schema.sql); this
 * service resolves the applicable rule, computes the amount, records an
 * immutable fee_charge, and — depending on the method the payer chooses —
 * settles it against their ledger balance, a card payment, or a manual
 * bank/crypto transfer that an admin later verifies.
 *
 * GATEWAYS THAT CALL THIS:
 *   - artworkService.submitForReview  -> fee type 'artwork_upload'
 *   - payoutService.requestPayout     -> fee type 'withdrawal'
 *   - orderService.createFromCart     -> fee type 'order_payment_processing'
 * Adding a new chargeable action anywhere else is just a call to
 * getOrCreateCharge({ feeTypeCode: 'new_code', ... }) — no new
 * fee-calculation logic needed at the call site.
 */

async function resolveApplicableFee(feeTypeCode, { artistId, categoryId, baseAmount, currency } = {}) {
  const { data: feeType, error: ftErr } = await supabaseAdmin
    .from('fee_types')
    .select('id, code, is_active')
    .eq('code', feeTypeCode)
    .maybeSingle();

  if (ftErr) throw new AppError('Could not resolve fee configuration.', 500, 'FEE_LOOKUP_FAILED');
  if (!feeType || !feeType.is_active) return null; // no fee configured/active for this action — free

  const nowIso = new Date().toISOString();
  const { data: rules } = await supabaseAdmin
    .from('fee_rules')
    .select('*')
    .eq('fee_type_id', feeType.id)
    .eq('is_active', true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`);

  if (!rules || rules.length === 0) return null;

  // Priority: artist-specific > category-specific > promotion > global.
  const rule =
    rules.find((r) => r.scope === 'artist' && r.artist_id === artistId) ||
    rules.find((r) => r.scope === 'category' && r.category_id === categoryId) ||
    rules.find((r) => r.scope === 'promotion') ||
    rules.find((r) => r.scope === 'global');

  if (!rule) return null;

  let amount;
  if (rule.calculation_type === 'fixed') {
    amount = Number(rule.fixed_amount);
  } else if (rule.calculation_type === 'percentage') {
    if (baseAmount == null) throw new AppError('This fee requires a base amount to calculate.', 500, 'FEE_CALC_ERROR');
    amount = round2((Number(baseAmount) * Number(rule.percentage)) / 100);
  } else {
    amount = 0; // 'tiered' — placeholder until tiered-bracket logic is configured
  }

  if (rule.min_amount != null) amount = Math.max(amount, Number(rule.min_amount));
  if (rule.max_amount != null) amount = Math.min(amount, Number(rule.max_amount));

  return { feeType, rule, amount: round2(amount), currency: rule.currency || currency };
}

/**
 * Returns an existing unpaid/paid charge for this entity if one exists
 * (so re-checking a gateway doesn't spawn duplicates), otherwise resolves
 * the fee and creates a new pending charge. Returns `null` if no fee is
 * configured for this action — callers must treat `null` as "proceed,
 * nothing owed."
 */
async function getOrCreateCharge({ feeTypeCode, userId, relatedEntityType, relatedEntityId, artistId, categoryId, baseAmount, currency }) {
  const { data: feeTypeRow } = await supabaseAdmin.from('fee_types').select('id').eq('code', feeTypeCode).maybeSingle();

  if (feeTypeRow) {
    const { data: existing } = await supabaseAdmin
      .from('fee_charges')
      .select('*')
      .eq('fee_type_id', feeTypeRow.id)
      .eq('related_entity_type', relatedEntityType)
      .eq('related_entity_id', relatedEntityId)
      .in('status', ['pending', 'awaiting_verification', 'paid'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return existing;
  }

  const resolved = await resolveApplicableFee(feeTypeCode, { artistId, categoryId, baseAmount, currency });
  if (!resolved || resolved.amount <= 0) return null;

  const { data: charge, error } = await supabaseAdmin
    .from('fee_charges')
    .insert({
      fee_type_id: resolved.feeType.id,
      fee_rule_id: resolved.rule.id,
      user_id: userId,
      related_entity_type: relatedEntityType,
      related_entity_id: relatedEntityId,
      amount: resolved.amount,
      currency: resolved.currency || currency,
      status: 'pending',
    })
    .select('*')
    .single();

  if (error) throw new AppError('Could not create fee charge.', 500, 'FEE_CREATE_FAILED');
  return charge;
}

/** Whether a given gateway's charge (if any) is settled — the guard callers use before proceeding. */
function isSettled(charge) {
  return !charge || charge.status === 'paid' || charge.status === 'waived';
}

async function getCharge(chargeId, userId) {
  const { data, error } = await supabaseAdmin.from('fee_charges').select('*').eq('id', chargeId).eq('user_id', userId).maybeSingle();
  if (error) throw new AppError('Could not load fee charge.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Fee charge not found.', 404, 'NOT_FOUND');
  return data;
}

async function listMyCharges(userId, { status } = {}) {
  let query = supabaseAdmin.from('fee_charges').select('*, fee_types(code, name)').eq('user_id', userId).order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new AppError('Could not load fee charges.', 500, 'QUERY_FAILED');
  return data;
}

/**
 * Settles a charge via immediate deduction from the user's own ledger
 * balance — only valid for users who have an available balance (artists).
 * Posts a 'fee' ledger entry debiting the artist and crediting the
 * platform, exactly as any other financial movement (spec section 26).
 */
async function settleByBalanceDeduction(chargeId, userId, artistProfileId) {
  const charge = await getCharge(chargeId, userId);
  if (charge.status === 'paid') return charge;
  if (charge.status !== 'pending') throw new AppError('This charge cannot be paid from balance in its current state.', 400, 'INVALID_STATE');

  const account = await ledgerService.getOrCreateAccount('artist', artistProfileId, charge.currency);
  if (Number(account.available_balance) < Number(charge.amount)) {
    throw new AppError('Insufficient available balance to cover this fee.', 402, 'INSUFFICIENT_BALANCE');
  }

  const platformAccount = await ledgerService.getOrCreateAccount('platform', null, charge.currency);

  await ledgerService.insertEntry({
    reference: `FEE-${charge.id}`, ledgerAccountId: account.id, entryType: 'fee', direction: 'debit',
    amount: charge.amount, currency: charge.currency, relatedUserId: userId,
  });
  await ledgerService.insertEntry({
    reference: `FEE-${charge.id}`, ledgerAccountId: platformAccount.id, entryType: 'fee', direction: 'credit',
    amount: charge.amount, currency: charge.currency, relatedUserId: userId,
  });

  await supabaseAdmin
    .from('ledger_accounts')
    .update({ available_balance: Number(account.available_balance) - Number(charge.amount) })
    .eq('id', account.id);

  const { data: updated, error } = await supabaseAdmin
    .from('fee_charges')
    .update({ status: 'paid', payment_method: 'balance_deduction', paid_at: new Date().toISOString() })
    .eq('id', chargeId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not finalize fee payment.', 500, 'UPDATE_FAILED');
  return updated;
}

/**
 * Selects a manual settlement path (bank transfer or crypto): attaches
 * the admin-published destination the payer should send funds to.
 * Nothing is trusted as paid until an admin verifies the proof
 * (verifyManualPayment below) — mirrors "never trust the browser to
 * confirm payment" for the primary checkout flow.
 */
async function selectManualDestination(chargeId, userId, method, destinationId) {
  if (!['bank_transfer', 'crypto'].includes(method)) {
    throw new AppError('Invalid manual payment method.', 400, 'INVALID_METHOD');
  }
  const charge = await getCharge(chargeId, userId);
  if (charge.status !== 'pending') throw new AppError('This charge is not awaiting payment.', 400, 'INVALID_STATE');

  const { data: destination, error: destErr } = await supabaseAdmin
    .from('admin_payment_destinations')
    .select('*')
    .eq('id', destinationId)
    .eq('is_active', true)
    .eq('type', method === 'bank_transfer' ? 'bank_account' : 'crypto_wallet')
    .maybeSingle();

  if (destErr || !destination) throw new AppError('Selected payment destination is not available.', 404, 'NOT_FOUND');

  const { data: updated, error } = await supabaseAdmin
    .from('fee_charges')
    .update({ payment_method: method, payment_destination_id: destination.id })
    .eq('id', chargeId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not update fee charge.', 500, 'UPDATE_FAILED');
  return { charge: updated, destination: maskDestination(destination) };
}

/** Attaches the payer's proof of transfer and moves the charge to awaiting admin verification. */
async function attachProof(chargeId, userId, proofStoragePath) {
  const charge = await getCharge(chargeId, userId);
  if (!['bank_transfer', 'crypto'].includes(charge.payment_method)) {
    throw new AppError('Proof upload only applies to bank transfer or crypto payments.', 400, 'INVALID_METHOD');
  }

  const { data, error } = await supabaseAdmin
    .from('fee_charges')
    .update({ proof_url: proofStoragePath, status: 'awaiting_verification' })
    .eq('id', chargeId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not record payment proof.', 500, 'UPDATE_FAILED');
  return data;
}

/** Admin verifies (or rejects) a manually-submitted bank/crypto fee payment. */
async function verifyManualPayment(chargeId, adminUserId, approve, note) {
  const { data: charge, error: fetchErr } = await supabaseAdmin.from('fee_charges').select('*').eq('id', chargeId).single();
  if (fetchErr || !charge) throw new AppError('Fee charge not found.', 404, 'NOT_FOUND');
  if (charge.status !== 'awaiting_verification') {
    throw new AppError('Only charges awaiting verification can be resolved.', 400, 'INVALID_STATE');
  }

  if (approve) {
    const platformAccount = await ledgerService.getOrCreateAccount('platform', null, charge.currency);
    await ledgerService.insertEntry({
      reference: `FEE-${charge.id}`, ledgerAccountId: platformAccount.id, entryType: 'fee', direction: 'credit',
      amount: charge.amount, currency: charge.currency, relatedUserId: charge.user_id,
    });
  }

  const { data, error } = await supabaseAdmin
    .from('fee_charges')
    .update({
      status: approve ? 'paid' : 'failed',
      verified_by: adminUserId,
      verified_at: new Date().toISOString(),
      paid_at: approve ? new Date().toISOString() : null,
      notes: note || charge.notes,
    })
    .eq('id', chargeId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not update fee charge.', 500, 'UPDATE_FAILED');
  return data;
}

/** Admin waives a fee entirely (goodwill, promotional exemption) — no money moves, but it's fully audited. */
async function waiveCharge(chargeId, adminUserId, reason) {
  const { data, error } = await supabaseAdmin
    .from('fee_charges')
    .update({ status: 'waived', verified_by: adminUserId, verified_at: new Date().toISOString(), notes: reason })
    .eq('id', chargeId)
    .in('status', ['pending', 'awaiting_verification'])
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not waive fee charge.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only pending or awaiting-verification charges can be waived.', 400, 'INVALID_STATE');
  return data;
}

function maskDestination(destination) {
  const masked = { ...destination };
  if (masked.account_number_encrypted) {
    masked.account_number_display = `••••${String(masked.account_number_encrypted).slice(-4)}`;
  }
  delete masked.account_number_encrypted;
  return masked;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// Admin configuration CRUD — "admin can set any kind of fee at any point"
// ---------------------------------------------------------------------
async function listFeeTypes() {
  const { data, error } = await supabaseAdmin.from('fee_types').select('*, fee_rules(*)').order('created_at', { ascending: false });
  if (error) throw new AppError('Could not load fee types.', 500, 'QUERY_FAILED');
  return data;
}

async function createFeeType(adminUserId, { code, name, description }) {
  const { data, error } = await supabaseAdmin.from('fee_types').insert({ code, name, description, created_by: adminUserId }).select('*').single();
  if (error) throw new AppError('Could not create fee type — the code may already exist.', 409, 'CREATE_FAILED');
  return data;
}

async function updateFeeType(feeTypeId, payload) {
  const updates = {};
  for (const field of ['name', 'description', 'is_active']) if (payload[field] !== undefined) updates[field] = payload[field];
  const { data, error } = await supabaseAdmin.from('fee_types').update(updates).eq('id', feeTypeId).select('*').single();
  if (error) throw new AppError('Could not update fee type.', 500, 'UPDATE_FAILED');
  return data;
}

async function createFeeRule(adminUserId, payload) {
  const { data, error } = await supabaseAdmin.from('fee_rules').insert({ ...payload, created_by: adminUserId }).select('*').single();
  if (error) throw new AppError('Could not create fee rule.', 500, 'CREATE_FAILED');
  return data;
}

async function updateFeeRule(feeRuleId, payload) {
  const editable = [
    'scope', 'artist_id', 'category_id', 'calculation_type', 'percentage', 'fixed_amount',
    'currency', 'min_amount', 'max_amount', 'is_active', 'starts_at', 'ends_at',
  ];
  const updates = {};
  for (const field of editable) if (payload[field] !== undefined) updates[field] = payload[field];
  const { data, error } = await supabaseAdmin.from('fee_rules').update(updates).eq('id', feeRuleId).select('*').single();
  if (error) throw new AppError('Could not update fee rule.', 500, 'UPDATE_FAILED');
  return data;
}

async function deleteFeeRule(feeRuleId) {
  // Deactivate rather than hard-delete — a rule may be referenced by
  // historical fee_charges and must remain resolvable in audits.
  const { error } = await supabaseAdmin.from('fee_rules').update({ is_active: false }).eq('id', feeRuleId);
  if (error) throw new AppError('Could not deactivate fee rule.', 500, 'UPDATE_FAILED');
}

async function listPaymentDestinations({ includeInactive = false } = {}) {
  let query = supabaseAdmin.from('admin_payment_destinations').select('*').order('created_at', { ascending: false });
  if (!includeInactive) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw new AppError('Could not load payment destinations.', 500, 'QUERY_FAILED');
  return data.map(maskDestination);
}

async function createPaymentDestination(adminUserId, payload) {
  const { data, error } = await supabaseAdmin.from('admin_payment_destinations').insert({ ...payload, created_by: adminUserId }).select('*').single();
  if (error) throw new AppError('Could not create payment destination.', 500, 'CREATE_FAILED');
  return maskDestination(data);
}

async function updatePaymentDestination(destinationId, payload) {
  const editable = [
    'label', 'currency', 'bank_name', 'account_name', 'account_number_encrypted', 'routing_info',
    'crypto_network', 'crypto_address', 'instructions', 'is_active',
  ];
  const updates = {};
  for (const field of editable) if (payload[field] !== undefined) updates[field] = payload[field];
  const { data, error } = await supabaseAdmin.from('admin_payment_destinations').update(updates).eq('id', destinationId).select('*').single();
  if (error) throw new AppError('Could not update payment destination.', 500, 'UPDATE_FAILED');
  return maskDestination(data);
}

async function listAllCharges({ status, page = 1, pageSize = 30 } = {}) {
  let query = supabaseAdmin
    .from('fee_charges')
    .select('*, fee_types(code, name), users:user_id(email, full_name)', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load fee charges.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

module.exports = {
  resolveApplicableFee, getOrCreateCharge, isSettled, getCharge, listMyCharges,
  settleByBalanceDeduction, selectManualDestination, attachProof, verifyManualPayment, waiveCharge,
  listFeeTypes, createFeeType, updateFeeType, createFeeRule, updateFeeRule, deleteFeeRule,
  listPaymentDestinations, createPaymentDestination, updatePaymentDestination, listAllCharges,
};
