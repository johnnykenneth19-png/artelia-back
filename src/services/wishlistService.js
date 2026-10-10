const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * A user's default wishlist is created lazily on first use rather than
 * at registration — most buyers never touch it, so no need to write a
 * row for every signup. Multiple named wishlists ("collections") are
 * supported per spec section 13 via the same table.
 */
async function getOrCreateDefault(userId) {
  const { data: existing } = await supabaseAdmin
    .from('wishlists')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabaseAdmin.from('wishlists').insert({ user_id: userId, name: 'My Wishlist' }).select('*').single();
  if (error) throw new AppError('Could not create wishlist.', 500, 'CREATE_FAILED');
  return data;
}

async function listMine(userId) {
  const { data, error } = await supabaseAdmin
    .from('wishlists')
    .select(`
      id, name, is_shared, share_token, created_at,
      wishlist_items (
        id, added_at,
        artworks ( id, title, slug, price, currency, status,
          artwork_images ( public_url, thumbnail_url, image_type ),
          artist_profiles ( artist_name, slug )
        )
      )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Could not load wishlists.', 500, 'QUERY_FAILED');
  return data;
}

async function createWishlist(userId, name) {
  const { data, error } = await supabaseAdmin.from('wishlists').insert({ user_id: userId, name }).select('*').single();
  if (error) throw new AppError('Could not create wishlist.', 500, 'CREATE_FAILED');
  return data;
}

async function addItem(userId, wishlistId, artworkId) {
  // Ownership check: the wishlist must belong to the caller.
  const { data: wishlist } = await supabaseAdmin.from('wishlists').select('id').eq('id', wishlistId).eq('user_id', userId).maybeSingle();
  if (!wishlist) throw new AppError('Wishlist not found.', 404, 'NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('wishlist_items')
    .upsert({ wishlist_id: wishlistId, artwork_id: artworkId }, { onConflict: 'wishlist_id,artwork_id' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not add artwork to wishlist.', 500, 'CREATE_FAILED');

  // Fire-and-forget favorites counter — not critical path.
  supabaseAdmin.rpc('increment_artwork_favorites', { artwork_id: artworkId }).then(() => {}, () => {});

  return data;
}

async function removeItem(userId, wishlistId, artworkId) {
  const { data: wishlist } = await supabaseAdmin.from('wishlists').select('id').eq('id', wishlistId).eq('user_id', userId).maybeSingle();
  if (!wishlist) throw new AppError('Wishlist not found.', 404, 'NOT_FOUND');

  const { error } = await supabaseAdmin.from('wishlist_items').delete().eq('wishlist_id', wishlistId).eq('artwork_id', artworkId);
  if (error) throw new AppError('Could not remove artwork from wishlist.', 500, 'DELETE_FAILED');

  supabaseAdmin.rpc('decrement_artwork_favorites', { artwork_id: artworkId }).then(() => {}, () => {});
}

/** Enables sharing (spec section 13: "share collections") by minting a public token, or returns the existing one. */
async function enableSharing(userId, wishlistId) {
  const { data: wishlist } = await supabaseAdmin.from('wishlists').select('*').eq('id', wishlistId).eq('user_id', userId).maybeSingle();
  if (!wishlist) throw new AppError('Wishlist not found.', 404, 'NOT_FOUND');
  if (wishlist.share_token) return wishlist;

  const crypto = require('crypto');
  const token = crypto.randomBytes(12).toString('hex');

  const { data, error } = await supabaseAdmin
    .from('wishlists')
    .update({ is_shared: true, share_token: token })
    .eq('id', wishlistId)
    .select('*')
    .single();

  if (error) throw new AppError('Could not enable sharing.', 500, 'UPDATE_FAILED');
  return data;
}

async function getBySharedToken(token) {
  const { data, error } = await supabaseAdmin
    .from('wishlists')
    .select(`
      id, name,
      wishlist_items ( artworks ( id, title, slug, price, currency, status, artwork_images ( public_url, thumbnail_url, image_type ) ) )
    `)
    .eq('share_token', token)
    .eq('is_shared', true)
    .maybeSingle();

  if (error) throw new AppError('Could not load shared wishlist.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Shared wishlist not found.', 404, 'NOT_FOUND');
  return data;
}

module.exports = { getOrCreateDefault, listMine, createWishlist, addItem, removeItem, enableSharing, getBySharedToken };
