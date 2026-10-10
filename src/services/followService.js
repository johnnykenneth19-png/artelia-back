const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const notificationService = require('./notificationService');

/**
 * ARTIST FOLLOW (spec section 14). `artist_profiles.followers_count` is
 * kept in sync via an atomic RPC (same pattern as the favorites counter
 * in wishlistService) rather than a read-then-write increment, so
 * concurrent follows/unfollows can never drift the count.
 */

async function follow(followerUserId, artistId) {
  const { data: artist, error: artistError } = await supabaseAdmin
    .from('artist_profiles').select('id, user_id').eq('id', artistId).maybeSingle();
  if (artistError || !artist) throw new AppError('Artist not found.', 404, 'NOT_FOUND');
  if (artist.user_id === followerUserId) throw new AppError('You cannot follow your own artist profile.', 400, 'CANNOT_FOLLOW_SELF');

  const { data, error } = await supabaseAdmin
    .from('artist_follows')
    .insert({ follower_user_id: followerUserId, artist_id: artistId })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') return { alreadyFollowing: true }; // idempotent — following twice is a no-op, not an error
    throw new AppError('Could not follow artist.', 500, 'INSERT_FAILED');
  }

  await supabaseAdmin.rpc('increment_artist_followers', { p_artist_id: artistId });
  return data;
}

async function unfollow(followerUserId, artistId) {
  const { error, count } = await supabaseAdmin
    .from('artist_follows')
    .delete({ count: 'exact' })
    .eq('follower_user_id', followerUserId)
    .eq('artist_id', artistId);

  if (error) throw new AppError('Could not unfollow artist.', 500, 'DELETE_FAILED');
  if (count) await supabaseAdmin.rpc('decrement_artist_followers', { p_artist_id: artistId });
}

async function isFollowing(followerUserId, artistId) {
  const { data } = await supabaseAdmin
    .from('artist_follows').select('id').eq('follower_user_id', followerUserId).eq('artist_id', artistId).maybeSingle();
  return !!data;
}

/** Buyer dashboard: "Followed artists" (spec section 12). */
async function listFollowing(followerUserId) {
  const { data, error } = await supabaseAdmin
    .from('artist_follows')
    .select('created_at, artist_profiles(id, artist_name, slug, profile_image_url, is_verified, followers_count)')
    .eq('follower_user_id', followerUserId)
    .order('created_at', { ascending: false });

  if (error) throw new AppError('Could not load followed artists.', 500, 'QUERY_FAILED');
  return data.map((row) => ({ followedAt: row.created_at, ...row.artist_profiles }));
}

/** Artist-facing: who's following them (not publicly exposed — only the artist/admin can see the list itself; the count alone is public). */
async function listFollowers(artistId, { page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('artist_follows')
    .select('created_at, users:follower_user_id(full_name)', { count: 'exact' })
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load followers.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

/**
 * Called from artworkService.publish() (spec section 14: "When an
 * artist publishes new artwork, followers can receive notifications").
 * Never lets a notification failure block the publish itself —
 * notificationService.create already swallows its own errors.
 */
async function notifyFollowersOfNewArtwork(artwork) {
  const { data: followers, error } = await supabaseAdmin
    .from('artist_follows').select('follower_user_id').eq('artist_id', artwork.artist_id);

  if (error || !followers?.length) return;

  const { data: artistProfile } = await supabaseAdmin
    .from('artist_profiles').select('artist_name').eq('id', artwork.artist_id).maybeSingle();

  await Promise.all(followers.map((f) => notificationService.create(f.follower_user_id, {
    type: 'new_artist_artwork',
    title: 'New artwork from an artist you follow',
    body: `${artistProfile?.artist_name || 'An artist you follow'} just published "${artwork.title}".`,
    data: { artworkId: artwork.id, artistId: artwork.artist_id },
  })));
}

module.exports = { follow, unfollow, isFollowing, listFollowing, listFollowers, notifyFollowersOfNewArtwork };
