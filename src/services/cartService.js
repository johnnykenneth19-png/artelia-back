const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * Spec section 15: "Do not trust cart prices sent from the frontend. The
 * backend must retrieve the current price from the database during
 * checkout." cart_items never stores a price at all (see schema.sql) —
 * every response here joins live against artworks so the price/
 * availability shown is always current.
 */
async function listMine(userId) {
  const { data, error } = await supabaseAdmin
    .from('cart_items')
    .select(`
      id, added_at,
      artworks (
        id, title, slug, price, currency, status, artwork_type,
        artwork_images ( public_url, thumbnail_url, image_type ),
        artist_profiles ( id, artist_name, slug )
      )
    `)
    .eq('user_id', userId)
    .order('added_at', { ascending: false });

  if (error) throw new AppError('Could not load cart.', 500, 'QUERY_FAILED');

  // Surface items whose artwork sold/became unavailable since being added,
  // so the frontend can prompt removal rather than silently carrying a
  // dead item into checkout.
  return data.map((item) => ({ ...item, isAvailable: item.artworks?.status === 'published' }));
}

async function addItem(userId, artworkId) {
  const { data: artwork } = await supabaseAdmin.from('artworks').select('id, status').eq('id', artworkId).maybeSingle();
  if (!artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');
  if (artwork.status !== 'published') throw new AppError('This artwork is not currently available for purchase.', 400, 'ARTWORK_UNAVAILABLE');

  const { data, error } = await supabaseAdmin
    .from('cart_items')
    .upsert({ user_id: userId, artwork_id: artworkId }, { onConflict: 'user_id,artwork_id' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not add artwork to cart.', 500, 'CREATE_FAILED');
  return data;
}

async function removeItem(userId, artworkId) {
  const { error } = await supabaseAdmin.from('cart_items').delete().eq('user_id', userId).eq('artwork_id', artworkId);
  if (error) throw new AppError('Could not remove item from cart.', 500, 'DELETE_FAILED');
}

async function clear(userId) {
  const { error } = await supabaseAdmin.from('cart_items').delete().eq('user_id', userId);
  if (error) throw new AppError('Could not clear cart.', 500, 'DELETE_FAILED');
}

module.exports = { listMine, addItem, removeItem, clear };
