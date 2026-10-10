const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

async function getProfileByUserId(userId) {
  const { data, error } = await supabaseAdmin.from('artist_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new AppError('Could not load artist profile.', 500, 'QUERY_FAILED');
  return data;
}

async function getPublicProfileBySlug(slug) {
  const { data, error } = await supabaseAdmin
    .from('artist_profiles')
    .select(`
      id, artist_name, slug, bio, artist_statement, location, country, specialties, mediums,
      education, awards, exhibitions, social_links, website, profile_image_url, cover_image_url,
      is_verified, followers_count, created_at
    `)
    .eq('slug', slug)
    .eq('status', 'approved')
    .maybeSingle();

  if (error) throw new AppError('Could not load artist profile.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Artist not found.', 404, 'NOT_FOUND');
  return data;
}

/**
 * Step 1-2 of "Become an Artist" onboarding (spec section 9): creates the
 * artist_profiles row in PENDING status and grants the 'artist' role
 * entry (though primary_role / dashboard access still gates on
 * status === 'approved' — see requireRole + createDraft's approval check).
 */
async function applyAsArtist(userId, payload) {
  const existing = await getProfileByUserId(userId);
  if (existing) throw new AppError('You already have an artist profile.', 409, 'ALREADY_EXISTS');

  const { data, error } = await supabaseAdmin
    .from('artist_profiles')
    .insert({
      user_id: userId,
      artist_name: payload.artistName,
      slug: payload.slug,
      bio: payload.bio,
      location: payload.location,
      country: payload.country,
      specialties: payload.specialties || [],
      mediums: payload.mediums || [],
      website: payload.website,
      status: 'pending',
    })
    .select('*')
    .single();

  if (error) throw new AppError('Could not submit artist application.', 500, 'CREATE_FAILED');

  await supabaseAdmin.from('user_roles').upsert({ user_id: userId, role: 'artist' }, { onConflict: 'user_id,role' });
  await supabaseAdmin.from('users').update({ primary_role: 'artist' }).eq('id', userId);

  // Kick off the verification record — Step 3 of onboarding (documents
  // are attached separately via uploadService.uploadVerificationDocument).
  await supabaseAdmin.from('artist_verifications').insert({ artist_id: data.id, status: 'pending' });

  return data;
}

const EDITABLE_PROFILE_FIELDS = [
  'bio', 'artist_statement', 'location', 'country', 'specialties', 'mediums',
  'education', 'awards', 'exhibitions', 'social_links', 'website',
  'profile_image_url', 'cover_image_url',
];

async function updateProfile(artistProfileId, payload) {
  const updates = {};
  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (payload[field] !== undefined) updates[field] = payload[field];
  }
  // Note: `status`, `is_verified`, `verification_status`, `commission_rate_override`
  // are deliberately absent from EDITABLE_PROFILE_FIELDS — those change
  // only through the admin verification flow, never a self-service update.

  const { data, error } = await supabaseAdmin
    .from('artist_profiles')
    .update(updates)
    .eq('id', artistProfileId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not update profile.', 500, 'UPDATE_FAILED');
  return data;
}

/**
 * Aggregates the artist dashboard overview (spec section 10): sales,
 * earnings/balances (from the ledger — never a denormalized counter),
 * artwork views/favorites, and pending action counts.
 */
async function getDashboardOverview(artistProfileId, currency, userId) {
  const [{ count: totalArtworks }, { count: publishedCount }, { count: soldCount }, ledgerAccount, { count: pendingOffers }, { count: unreadMessages }] =
    await Promise.all([
      supabaseAdmin.from('artworks').select('id', { count: 'exact', head: true }).eq('artist_id', artistProfileId),
      supabaseAdmin.from('artworks').select('id', { count: 'exact', head: true }).eq('artist_id', artistProfileId).eq('status', 'published'),
      supabaseAdmin.from('artworks').select('id', { count: 'exact', head: true }).eq('artist_id', artistProfileId).eq('status', 'sold'),
      supabaseAdmin.from('ledger_accounts').select('available_balance, pending_balance').eq('owner_type', 'artist').eq('owner_id', artistProfileId).eq('currency', currency).maybeSingle(),
      supabaseAdmin.from('offers').select('id', { count: 'exact', head: true }).eq('artist_id', artistProfileId).eq('status', 'pending'),
      // Note: messages.recipient_id references users.id, not artist_profiles.id — use the user's own id here.
      supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('recipient_id', userId).eq('is_read', false),
    ]);

  const { data: viewsAgg } = await supabaseAdmin
    .from('artworks')
    .select('views_count, favorites_count')
    .eq('artist_id', artistProfileId);

  const totalViews = (viewsAgg || []).reduce((sum, a) => sum + (a.views_count || 0), 0);
  const totalFavorites = (viewsAgg || []).reduce((sum, a) => sum + (a.favorites_count || 0), 0);

  return {
    totalArtworks: totalArtworks || 0,
    publishedArtworks: publishedCount || 0,
    totalSales: soldCount || 0,
    availableBalance: ledgerAccount.data?.available_balance || 0,
    pendingBalance: ledgerAccount.data?.pending_balance || 0,
    currency,
    totalViews,
    totalFavorites,
    pendingOffers: pendingOffers || 0,
    unreadMessages: unreadMessages || 0,
  };
}

/**
 * Payout bank account (spec section 9, Step 4). Stored per-artist;
 * the account number is masked on every read — only the payout provider
 * integration (payoutProviderService) reads the raw value, and only at
 * the moment a real transfer is initiated. Production deployments
 * should encrypt this column at rest (pgcrypto/KMS) rather than storing
 * plaintext; that hookup is flagged here rather than silently assumed.
 */
async function getPayoutAccount(artistProfileId) {
  const { data, error } = await supabaseAdmin.from('artist_payout_accounts').select('*').eq('artist_id', artistProfileId).maybeSingle();
  if (error) throw new AppError('Could not load payout account.', 500, 'QUERY_FAILED');
  if (!data) return null;

  const masked = { ...data };
  if (masked.account_number_encrypted) {
    masked.account_number_display = `••••${String(masked.account_number_encrypted).slice(-4)}`;
  }
  delete masked.account_number_encrypted;
  return masked;
}

async function upsertPayoutAccount(artistProfileId, { bankName, bankCode, accountName, accountNumber, currency }) {
  const { data: existing } = await supabaseAdmin.from('artist_payout_accounts').select('id').eq('artist_id', artistProfileId).maybeSingle();

  const payload = {
    artist_id: artistProfileId,
    bank_name: bankName,
    bank_code: bankCode,
    account_name: accountName,
    account_number_encrypted: accountNumber, // TODO(production): encrypt before storing
    currency: currency || 'NGN',
    is_verified: false, // any change to bank details requires re-verification
    provider_recipient_code: null, // invalidate any cached provider recipient on change
  };

  const query = existing
    ? supabaseAdmin.from('artist_payout_accounts').update(payload).eq('id', existing.id)
    : supabaseAdmin.from('artist_payout_accounts').insert(payload);

  const { data, error } = await query.select('*').single();
  if (error) throw new AppError('Could not save payout account.', 500, 'UPDATE_FAILED');

  const masked = { ...data };
  delete masked.account_number_encrypted;
  return masked;
}

module.exports = {
  getProfileByUserId,
  getPublicProfileBySlug,
  applyAsArtist,
  updateProfile,
  getDashboardOverview,
  getPayoutAccount,
  upsertPayoutAccount,
};
