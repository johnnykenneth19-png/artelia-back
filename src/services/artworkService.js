const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const config = require('../config');

const PUBLIC_FIELDS = `
  id, title, slug, description, artist_statement, materials, year_created,
  width_cm, height_cm, depth_cm, weight_kg, orientation, is_framed,
  frame_width_cm, frame_height_cm, artwork_type, edition_number, edition_size,
  price, currency, status, location, country, condition, signature_info,
  copyright_info, offers_enabled, is_featured, views_count, favorites_count,
  published_at, created_at,
  artist_profiles ( id, artist_name, slug, profile_image_url, is_verified, country ),
  artwork_images ( id, image_type, public_url, thumbnail_url, sort_order )
`;

async function listPublished({ page = 1, pageSize = 24, filters = {}, sort = 'newest' }) {
  let query = supabaseAdmin.from('artworks').select(PUBLIC_FIELDS, { count: 'exact' }).eq('status', 'published');

  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters.mediumId) query = query.eq('medium_id', filters.mediumId);
  if (filters.styleId) query = query.eq('style_id', filters.styleId);
  if (filters.artistId) query = query.eq('artist_id', filters.artistId);
  if (filters.country) query = query.eq('country', filters.country);
  if (filters.artworkType) query = query.eq('artwork_type', filters.artworkType);
  if (filters.isFramed !== undefined) query = query.eq('is_framed', filters.isFramed);
  if (filters.isFeatured) query = query.eq('is_featured', true);
  if (filters.minPrice) query = query.gte('price', filters.minPrice);
  if (filters.maxPrice) query = query.lte('price', filters.maxPrice);
  if (filters.search) query = query.textSearch('search_vector', filters.search, { type: 'websearch' });

  const sortMap = {
    newest: { column: 'published_at', ascending: false },
    price_low: { column: 'price', ascending: true },
    price_high: { column: 'price', ascending: false },
    most_viewed: { column: 'views_count', ascending: false },
    most_favorited: { column: 'favorites_count', ascending: false },
  };
  const { column, ascending } = sortMap[sort] || sortMap.newest;
  query = query.order(column, { ascending });

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load artworks.', 500, 'QUERY_FAILED');

  return { items: data, total: count, page, pageSize };
}

async function getBySlug(slug) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .select(PUBLIC_FIELDS)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();

  if (error) throw new AppError('Could not load artwork.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');

  // Fire-and-forget view increment — not critical-path, don't block the response.
  supabaseAdmin.rpc('increment_artwork_views', { artwork_id: data.id }).then(
    () => {},
    () => {} // swallow — a missed view count is not worth failing the request
  );

  return data;
}

/**
 * Creates a new artwork in DRAFT status, owned by the calling artist.
 * Ownership is set server-side from the authenticated artist's profile —
 * never from a client-supplied artist_id — so an artist can't attribute
 * artwork to someone else.
 */
async function createDraft(artistProfileId, payload) {
  // If this artist belongs to a gallery's roster (spec section 39), the
  // artwork is automatically attributed to that gallery's inventory too
  // — set once at creation from the artist's own profile, never from a
  // client-supplied galleryId (which would let anyone attribute an
  // artwork to a gallery they have nothing to do with).
  const { data: artistProfile } = await supabaseAdmin
    .from('artist_profiles').select('gallery_id').eq('id', artistProfileId).maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('artworks')
    .insert({ ...payload, artist_id: artistProfileId, gallery_id: artistProfile?.gallery_id ?? null, status: 'draft' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not create artwork.', 500, 'CREATE_FAILED');
  return data;
}

/**
 * Submits a draft for admin review. Only the DRAFT -> PENDING_REVIEW
 * transition is allowed here; artists cannot self-publish, and cannot
 * move an artwork directly to PUBLISHED, RESERVED, or SOLD.
 */
async function submitForReview(artworkId) {
  const { data: artwork } = await supabaseAdmin.from('artworks').select('status').eq('id', artworkId).single();
  if (!artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');
  if (artwork.status !== 'draft') {
    throw new AppError('Only draft artworks can be submitted for review.', 400, 'INVALID_STATE_TRANSITION');
  }

  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'pending_review' })
    .eq('id', artworkId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not submit artwork for review.', 500, 'UPDATE_FAILED');
  return data;
}

/**
 * ATOMIC RESERVATION — the core of inventory protection (spec section 49).
 *
 * Attempts to move an artwork from AVAILABLE-equivalent status
 * ('published') to 'reserved', tagged with the reserving order, but ONLY
 * if it is still 'published' at the moment of the update. This is a
 * single conditional UPDATE (WHERE status = 'published'), which Postgres
 * executes atomically — if two checkouts race, only one UPDATE can match
 * the WHERE clause and return a row; the loser gets zero rows affected
 * and is told the artwork is no longer available. No application-level
 * locking or read-then-write gap is involved.
 */
async function reserveForCheckout(artworkId, orderId, { fromStatus = 'published' } = {}) {
  const reservedUntil = new Date(Date.now() + config.platform.reservationHoldMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'reserved', reserved_by_order_id: orderId, reserved_until: reservedUntil })
    .eq('id', artworkId)
    .eq('status', fromStatus) // <-- the atomic guard. 'published' for a first sale,
    // 'resale_listed' for a resale checkout (resaleService.reserveForResaleCheckout)
    // — the two can never cross-match, so a resale checkout can't accidentally
    // reserve an artwork that's merely published, or vice versa.
    .select('id, price, currency, artist_id')
    .maybeSingle();

  if (error) throw new AppError('Could not reserve artwork.', 500, 'RESERVATION_FAILED');
  if (!data) {
    throw new AppError('This artwork is no longer available — it may have just been purchased.', 409, 'ARTWORK_UNAVAILABLE');
  }
  return data;
}

/** Releases an expired or abandoned reservation back to its pre-checkout status (published, or resale_listed for a resale checkout). */
async function releaseReservation(artworkId, orderId, { toStatus = 'published' } = {}) {
  await supabaseAdmin
    .from('artworks')
    .update({ status: toStatus, reserved_by_order_id: null, reserved_until: null })
    .eq('id', artworkId)
    .eq('reserved_by_order_id', orderId); // only the order that holds it may release it
}

/** Finalizes a sale after payment confirmation — reserved -> sold, permanently. */
async function markSold(artworkId, orderId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'sold', sold_at: new Date().toISOString() })
    .eq('id', artworkId)
    .eq('reserved_by_order_id', orderId)
    .eq('status', 'reserved')
    .select('*')
    .maybeSingle();

  if (error || !data) {
    throw new AppError('Could not finalize artwork sale — reservation mismatch.', 409, 'SALE_FINALIZATION_FAILED');
  }
  return data;
}

// =====================================================================
// ARTIST DASHBOARD — artwork management (Phase 3)
// =====================================================================

const ARTIST_FIELDS = `
  id, title, slug, description, artist_statement, category_id, medium_id, style_id, subject_id,
  materials, year_created, width_cm, height_cm, depth_cm, weight_kg, orientation, is_framed,
  frame_width_cm, frame_height_cm, artwork_type, edition_number, edition_size, price, currency,
  status, location, country, condition, signature_info, copyright_info, offers_enabled,
  is_featured, views_count, favorites_count, rejection_reason, published_at, sold_at,
  created_at, updated_at,
  artwork_images ( id, image_type, public_url, thumbnail_url, storage_path, sort_order ),
  artwork_certificates ( certificate_number )
`;

/**
 * Lists artworks belonging to the given artist profile, across ALL
 * statuses (draft, pending, published, sold, etc.) — this is the artist's
 * own management view, distinct from the public catalog which only ever
 * shows 'published'. Ownership is enforced by filtering on artist_id
 * derived server-side from the session, never a client-supplied value.
 */
async function listForArtist(artistProfileId, { status, page = 1, pageSize = 24 } = {}) {
  let query = supabaseAdmin
    .from('artworks')
    .select(ARTIST_FIELDS, { count: 'exact' })
    .eq('artist_id', artistProfileId)
    .order('updated_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load your artworks.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getOwnedById(artworkId, artistProfileId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .select(ARTIST_FIELDS)
    .eq('id', artworkId)
    .eq('artist_id', artistProfileId)
    .maybeSingle();

  if (error) throw new AppError('Could not load artwork.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');
  return data;
}

// Fields an artist may freely edit. Status, price-after-sale, ownership,
// and view/favorite counters are intentionally excluded — those are
// controlled exclusively by the state-transition functions below or by
// admin/system processes, never by a generic "update artwork" call.
const EDITABLE_FIELDS = [
  'title', 'description', 'artist_statement', 'category_id', 'medium_id', 'style_id', 'subject_id',
  'materials', 'year_created', 'width_cm', 'height_cm', 'depth_cm', 'weight_kg', 'orientation',
  'is_framed', 'frame_width_cm', 'frame_height_cm', 'artwork_type', 'edition_number', 'edition_size',
  'price', 'currency', 'location', 'country', 'condition', 'signature_info', 'copyright_info',
  'offers_enabled',
];

/**
 * Updates an artwork's editable fields. Only allowed while the artwork is
 * in DRAFT or PENDING_REVIEW (and PENDING_REVIEW edits kick it back to
 * DRAFT, since admin approved a version that no longer exists) — once
 * PUBLISHED, price/detail changes go through a controlled re-review path
 * rather than silently changing what a buyer is currently viewing.
 * RESERVED/SOLD artworks can never be edited by the artist at all.
 */
async function updateOwned(artworkId, artistProfileId, payload) {
  const existing = await getOwnedById(artworkId, artistProfileId);

  if (!['draft', 'pending_review', 'rejected'].includes(existing.status)) {
    throw new AppError(
      'This artwork can no longer be edited directly — it is published, reserved, or sold. Unpublish it first.',
      400,
      'INVALID_STATE_TRANSITION'
    );
  }

  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (payload[field] !== undefined) updates[field] = payload[field];
  }

  // Any edit to a previously pending/rejected artwork resets it to draft
  // so it goes through review again rather than silently staying "pending".
  if (existing.status === 'pending_review' || existing.status === 'rejected') {
    updates.status = 'draft';
    updates.rejection_reason = null;
  }

  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update(updates)
    .eq('id', artworkId)
    .eq('artist_id', artistProfileId)
    .select(ARTIST_FIELDS)
    .single();

  if (error) throw new AppError('Could not update artwork.', 500, 'UPDATE_FAILED');
  return data;
}

/**
 * Unpublish: PUBLISHED -> DRAFT. Explicitly blocked once RESERVED or SOLD
 * — an artist must never be able to pull an artwork out from under a
 * buyer mid-checkout or after a completed sale (spec section 11).
 */
async function unpublish(artworkId, artistProfileId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'draft', published_at: null })
    .eq('id', artworkId)
    .eq('artist_id', artistProfileId)
    .eq('status', 'published') // guard: only from published
    .select(ARTIST_FIELDS)
    .maybeSingle();

  if (error) throw new AppError('Could not unpublish artwork.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only published artworks can be unpublished.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

/** Archive: any non-reserved, non-sold status -> ARCHIVED. Reversible only by admin. */
async function archive(artworkId, artistProfileId) {
  const existing = await getOwnedById(artworkId, artistProfileId);
  if (['reserved', 'sold'].includes(existing.status)) {
    throw new AppError('A reserved or sold artwork cannot be archived.', 400, 'INVALID_STATE_TRANSITION');
  }

  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'archived' })
    .eq('id', artworkId)
    .eq('artist_id', artistProfileId)
    .select(ARTIST_FIELDS)
    .single();

  if (error) throw new AppError('Could not archive artwork.', 500, 'UPDATE_FAILED');
  return data;
}

/**
 * Mark unavailable: PUBLISHED -> UNAVAILABLE (e.g. artist pulls it from
 * sale without fully unpublishing/archiving — stays visible in their
 * catalog history but buyers can't purchase it).
 * Explicitly NOT allowed from SOLD — spec section 11: an artist must
 * never be able to directly mark an already-paid artwork as available
 * again by cycling it through this or any other artist-facing transition.
 */
async function markUnavailable(artworkId, artistProfileId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'unavailable' })
    .eq('id', artworkId)
    .eq('artist_id', artistProfileId)
    .eq('status', 'published')
    .select(ARTIST_FIELDS)
    .maybeSingle();

  if (error) throw new AppError('Could not update artwork availability.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only published artworks can be marked unavailable.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

/** Attaches uploaded image records to an artwork (called after uploadService stores the files). */
async function addImages(artworkId, artistProfileId, images) {
  await getOwnedById(artworkId, artistProfileId); // ownership check, throws if not found/owned

  const rows = images.map((img, index) => ({
    artwork_id: artworkId,
    image_type: img.imageType || 'gallery',
    storage_path: img.storagePath,
    public_url: img.publicUrl,
    thumbnail_url: img.thumbnailUrl,
    sort_order: img.sortOrder ?? index,
  }));

  const { data, error } = await supabaseAdmin.from('artwork_images').insert(rows).select('*');
  if (error) throw new AppError('Could not save artwork images.', 500, 'UPLOAD_FAILED');
  return data;
}

async function removeImage(imageId, artworkId, artistProfileId) {
  await getOwnedById(artworkId, artistProfileId);
  const { error } = await supabaseAdmin.from('artwork_images').delete().eq('id', imageId).eq('artwork_id', artworkId);
  if (error) throw new AppError('Could not remove image.', 500, 'DELETE_FAILED');
}

// =====================================================================
// ADMIN MODERATION (spec section 30) — lives here because it operates
// on the same artwork state machine; a dedicated adminService can be
// split out once Phase 8 adds the full admin surface.
// =====================================================================

/** Admin approves a pending artwork: PENDING_REVIEW -> APPROVED (not yet publicly visible). */
async function approve(artworkId, adminUserId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'approved', reviewed_by: adminUserId, reviewed_at: new Date().toISOString(), rejection_reason: null })
    .eq('id', artworkId)
    .eq('status', 'pending_review')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not approve artwork.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only artworks pending review can be approved.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

/** Publishes an approved artwork, making it publicly visible and purchasable. */
async function publish(artworkId, adminUserId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', artworkId)
    .eq('status', 'approved')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not publish artwork.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only approved artworks can be published.', 400, 'INVALID_STATE_TRANSITION');

  // spec section 14: followers get notified when an artist they follow
  // publishes something new. Lazily required to avoid a require-cycle
  // (followService -> notificationService only, nothing back to this
  // file), and never allowed to fail the publish itself.
  require('./followService').notifyFollowersOfNewArtwork(data).catch((err) => {
    console.error('[artworkService] follower notification failed:', err.message);
  });

  return data;
}

/** Admin rejects a pending artwork with an internal reason, visible to the artist so they can revise. */
async function reject(artworkId, adminUserId, reason) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'rejected', reviewed_by: adminUserId, reviewed_at: new Date().toISOString(), rejection_reason: reason })
    .eq('id', artworkId)
    .eq('status', 'pending_review')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not reject artwork.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only artworks pending review can be rejected.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

/** Admin force-unpublishes any published artwork (moderation power, distinct from the artist's own unpublish). */
async function adminUnpublish(artworkId, adminUserId) {
  const { data, error } = await supabaseAdmin
    .from('artworks')
    .update({ status: 'draft', published_at: null })
    .eq('id', artworkId)
    .eq('status', 'published')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not unpublish artwork.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only published artworks can be unpublished.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function listPendingReview({ page = 1, pageSize = 24 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('artworks')
    .select(`${ARTIST_FIELDS}, artist_profiles ( id, artist_name, user_id )`, { count: 'exact' })
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true })
    .range(from, to);

  if (error) throw new AppError('Could not load pending artworks.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

module.exports = {
  listPublished,
  getBySlug,
  createDraft,
  submitForReview,
  reserveForCheckout,
  releaseReservation,
  markSold,
  listForArtist,
  getOwnedById,
  updateOwned,
  unpublish,
  archive,
  markUnavailable,
  addImages,
  removeImage,
  approve,
  publish,
  reject,
  adminUnpublish,
  listPendingReview,
};
