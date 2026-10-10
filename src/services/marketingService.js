const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * MARKETING SERVICE (spec section 44): featured artworks/artists,
 * homepage section ordering, discount codes, newsletter signups, and
 * email campaign scaffolding.
 *
 * Discount codes are resolved and the deducted amount is computed here,
 * server-side, from the order's real subtotal — never from a frontend-
 * supplied discount amount (spec section 64).
 */

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---- Featured content ----

async function setArtworkFeatured(artworkId, isFeatured) {
  const { data, error } = await supabaseAdmin
    .from('artworks').update({ is_featured: isFeatured }).eq('id', artworkId).select('id, title, is_featured').single();
  if (error) throw new AppError('Could not update artwork.', 500, 'UPDATE_FAILED');
  return data;
}

async function setArtistFeatured(artistProfileId, isFeatured) {
  const { data, error } = await supabaseAdmin
    .from('artist_profiles').update({ is_featured: isFeatured }).eq('id', artistProfileId).select('id, artist_name, is_featured').single();
  if (error) throw new AppError('Could not update artist.', 500, 'UPDATE_FAILED');
  return data;
}

// ---- Homepage sections ----

async function getHomepageSections() {
  const { data, error } = await supabaseAdmin.from('settings').select('value').eq('key', 'homepage_sections').maybeSingle();
  if (error) throw new AppError('Could not load homepage sections.', 500, 'QUERY_FAILED');
  return data?.value ?? [];
}

async function updateHomepageSections(sections) {
  if (!Array.isArray(sections)) throw new AppError('sections must be an array.', 422, 'VALIDATION_ERROR');
  const { data, error } = await supabaseAdmin
    .from('settings')
    .upsert({ key: 'homepage_sections', value: sections, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('value')
    .single();
  if (error) throw new AppError('Could not update homepage sections.', 500, 'UPDATE_FAILED');
  return data.value;
}

// ---- Discount codes ----

async function listDiscountCodes({ page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await supabaseAdmin
    .from('discount_codes').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (error) throw new AppError('Could not load discount codes.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function createDiscountCode(adminId, body) {
  const { code, discountType, value, currency, minOrderAmount, maxUses, maxUsesPerUser, startsAt, endsAt } = body;
  if (!code || !discountType || value == null) {
    throw new AppError('code, discountType and value are required.', 422, 'VALIDATION_ERROR');
  }
  if (discountType === 'fixed_amount' && !currency) {
    throw new AppError('A currency is required for a fixed-amount discount.', 422, 'VALIDATION_ERROR');
  }

  const { data, error } = await supabaseAdmin
    .from('discount_codes')
    .insert({
      code: code.trim().toUpperCase(),
      description: body.description ?? null,
      discount_type: discountType,
      value,
      currency: currency ?? null,
      min_order_amount: minOrderAmount ?? null,
      max_uses: maxUses ?? null,
      max_uses_per_user: maxUsesPerUser ?? null,
      starts_at: startsAt ?? null,
      ends_at: endsAt ?? null,
      created_by: adminId,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('A discount code with this name already exists.', 409, 'DUPLICATE_CODE');
    throw new AppError('Could not create discount code.', 500, 'INSERT_FAILED');
  }
  return data;
}

async function updateDiscountCode(id, updates) {
  const patch = {};
  for (const [key, col] of [
    ['description', 'description'], ['value', 'value'], ['currency', 'currency'],
    ['minOrderAmount', 'min_order_amount'], ['maxUses', 'max_uses'], ['maxUsesPerUser', 'max_uses_per_user'],
    ['startsAt', 'starts_at'], ['endsAt', 'ends_at'], ['isActive', 'is_active'],
  ]) {
    if (updates[key] !== undefined) patch[col] = updates[key];
  }
  const { data, error } = await supabaseAdmin.from('discount_codes').update(patch).eq('id', id).select('*').single();
  if (error) throw new AppError('Could not update discount code.', 500, 'UPDATE_FAILED');
  return data;
}

/**
 * Validates a discount code against a real order subtotal and returns
 * the resolved deduction amount. Called from orderService.createFromCart
 * — never trust a discount amount computed by the client.
 */
async function resolveDiscount(code, { buyerId, subtotal, currency }) {
  if (!code) return null;

  const { data: discount, error } = await supabaseAdmin
    .from('discount_codes')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new AppError('Could not validate discount code.', 500, 'QUERY_FAILED');
  if (!discount) throw new AppError('This discount code is not valid.', 400, 'INVALID_DISCOUNT_CODE');

  const now = new Date();
  if (discount.starts_at && now < new Date(discount.starts_at)) {
    throw new AppError('This discount code is not active yet.', 400, 'DISCOUNT_NOT_STARTED');
  }
  if (discount.ends_at && now > new Date(discount.ends_at)) {
    throw new AppError('This discount code has expired.', 400, 'DISCOUNT_EXPIRED');
  }
  if (discount.max_uses != null && discount.used_count >= discount.max_uses) {
    throw new AppError('This discount code has reached its usage limit.', 400, 'DISCOUNT_EXHAUSTED');
  }
  if (discount.min_order_amount != null && subtotal < discount.min_order_amount) {
    throw new AppError(`This code requires a minimum order of ${discount.min_order_amount} ${currency}.`, 400, 'DISCOUNT_MIN_NOT_MET');
  }
  if (discount.discount_type === 'fixed_amount' && discount.currency !== currency) {
    throw new AppError('This discount code is not valid for this currency.', 400, 'DISCOUNT_CURRENCY_MISMATCH');
  }

  if (discount.max_uses_per_user != null) {
    const { count: priorUses, error: countErr } = await supabaseAdmin
      .from('discount_code_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('discount_code_id', discount.id)
      .eq('user_id', buyerId);
    if (countErr) throw new AppError('Could not validate discount code.', 500, 'QUERY_FAILED');
    if (priorUses >= discount.max_uses_per_user) {
      throw new AppError('You have already used this discount code.', 400, 'DISCOUNT_ALREADY_USED');
    }
  }

  const amount = discount.discount_type === 'percentage'
    ? round2((subtotal * discount.value) / 100)
    : round2(Math.min(discount.value, subtotal));

  return { discountCodeId: discount.id, code: discount.code, amount };
}

/** Called once the order is finalized, to record the redemption and bump used_count. */
async function recordRedemption(discountCodeId, orderId, buyerId, amountDeducted) {
  await supabaseAdmin.from('discount_code_redemptions').insert({
    discount_code_id: discountCodeId, order_id: orderId, user_id: buyerId, amount_deducted: amountDeducted,
  });
  await supabaseAdmin.rpc('increment_discount_code_usage', { p_discount_code_id: discountCodeId }).catch(async () => {
    // Fallback if the RPC isn't present yet: non-atomic but still correct
    // under normal load since redemptions are also unique per order.
    const { data } = await supabaseAdmin.from('discount_codes').select('used_count').eq('id', discountCodeId).single();
    await supabaseAdmin.from('discount_codes').update({ used_count: (data?.used_count ?? 0) + 1 }).eq('id', discountCodeId);
  });
}

// ---- Newsletter ----

async function subscribeNewsletter(email, userId = null) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('A valid email is required.', 422, 'VALIDATION_ERROR');

  const { data, error } = await supabaseAdmin
    .from('newsletter_subscribers')
    .upsert({ email: email.toLowerCase().trim(), user_id: userId, is_subscribed: true, subscribed_at: new Date().toISOString(), unsubscribed_at: null }, { onConflict: 'email' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not subscribe to the newsletter.', 500, 'INSERT_FAILED');
  return data;
}

async function unsubscribeNewsletter(email) {
  const { error } = await supabaseAdmin
    .from('newsletter_subscribers')
    .update({ is_subscribed: false, unsubscribed_at: new Date().toISOString() })
    .eq('email', email.toLowerCase().trim());
  if (error) throw new AppError('Could not unsubscribe.', 500, 'UPDATE_FAILED');
}

async function listSubscribers({ page = 1, pageSize = 50 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await supabaseAdmin
    .from('newsletter_subscribers')
    .select('*', { count: 'exact' })
    .eq('is_subscribed', true)
    .order('subscribed_at', { ascending: false })
    .range(from, to);
  if (error) throw new AppError('Could not load subscribers.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

// ---- Email campaigns ----
// Data model + authoring/scheduling only. There is no email-provider
// client wired anywhere in this codebase yet (EMAIL_API_KEY is reserved
// in .env.example but unused) — "send" marks a campaign queued for a
// real background worker to dispatch via that provider in production.
// This is flagged rather than faking delivery.

async function listCampaigns({ page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await supabaseAdmin
    .from('email_campaigns').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (error) throw new AppError('Could not load campaigns.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function createCampaign(adminId, { name, subject, bodyHtml, segment, scheduledAt }) {
  if (!name || !subject || !bodyHtml) throw new AppError('name, subject and bodyHtml are required.', 422, 'VALIDATION_ERROR');

  const { data, error } = await supabaseAdmin
    .from('email_campaigns')
    .insert({
      name, subject, body_html: bodyHtml, segment: segment ?? 'all_subscribers',
      status: scheduledAt ? 'scheduled' : 'draft', scheduled_at: scheduledAt ?? null, created_by: adminId,
    })
    .select('*')
    .single();

  if (error) throw new AppError('Could not create campaign.', 500, 'INSERT_FAILED');
  return data;
}

async function queueCampaign(campaignId) {
  const { data, error } = await supabaseAdmin
    .from('email_campaigns')
    .update({ status: 'queued' })
    .eq('id', campaignId)
    .in('status', ['draft', 'scheduled'])
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not queue campaign.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only a draft or scheduled campaign can be queued.', 400, 'INVALID_STATE_TRANSITION');
  // NOTE: queuing is as far as this scaffold goes — see module header.
  return data;
}

async function cancelCampaign(campaignId) {
  const { data, error } = await supabaseAdmin
    .from('email_campaigns')
    .update({ status: 'cancelled' })
    .eq('id', campaignId)
    .in('status', ['draft', 'scheduled', 'queued'])
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not cancel campaign.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('This campaign can no longer be cancelled.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

module.exports = {
  setArtworkFeatured, setArtistFeatured,
  getHomepageSections, updateHomepageSections,
  listDiscountCodes, createDiscountCode, updateDiscountCode, resolveDiscount, recordRedemption,
  subscribeNewsletter, unsubscribeNewsletter, listSubscribers,
  listCampaigns, createCampaign, queueCampaign, cancelCampaign,
};
