const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * REVIEW SERVICE (spec section 33)
 * ---------------------------------------------------------------------
 * Only a buyer who actually completed a purchase of the specific
 * artwork may review it — enforced here by checking order_items/orders
 * directly, never by trusting a "verifiedPurchase" flag the client
 * sends. One review per (order, artwork) is also enforced at the
 * database level (reviews.unique(order_id, artwork_id)) as a backstop.
 */

async function assertVerifiedPurchase(buyerId, orderId, artworkId) {
  const { data, error } = await supabaseAdmin
    .from('order_items')
    .select('id, orders!inner(id, buyer_id, status)')
    .eq('order_id', orderId)
    .eq('artwork_id', artworkId)
    .eq('orders.buyer_id', buyerId)
    .maybeSingle();

  if (error) throw new AppError('Could not verify purchase.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('You can only review artworks you have purchased.', 403, 'NOT_VERIFIED_PURCHASE');

  const reviewableStatuses = ['delivered', 'completed'];
  if (!reviewableStatuses.includes(data.orders.status)) {
    throw new AppError('This order must be delivered before it can be reviewed.', 400, 'ORDER_NOT_DELIVERED');
  }
}

async function create(buyerId, { orderId, artworkId, rating, packagingRating, deliveryRating, comment }) {
  if (!orderId || !artworkId || !rating) {
    throw new AppError('orderId, artworkId and rating are required.', 422, 'VALIDATION_ERROR');
  }
  if (rating < 1 || rating > 5) throw new AppError('Rating must be between 1 and 5.', 422, 'VALIDATION_ERROR');

  await assertVerifiedPurchase(buyerId, orderId, artworkId);

  const { data: artwork, error: artworkError } = await supabaseAdmin
    .from('artworks')
    .select('id, artist_id')
    .eq('id', artworkId)
    .single();
  if (artworkError || !artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('reviews')
    .insert({
      order_id: orderId,
      buyer_id: buyerId,
      artist_id: artwork.artist_id,
      artwork_id: artworkId,
      rating,
      packaging_rating: packagingRating ?? null,
      delivery_rating: deliveryRating ?? null,
      comment: comment ?? null,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('You have already reviewed this purchase.', 409, 'DUPLICATE_REVIEW');
    throw new AppError('Could not submit review.', 500, 'INSERT_FAILED');
  }
  return data;
}

/**
 * Public review listing — anonymizes the buyer to a first name only
 * (spec section 59: never publicly expose buyer information).
 */
async function listForArtwork(artworkId, { page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('reviews')
    .select('id, rating, packaging_rating, delivery_rating, comment, created_at, users:buyer_id(full_name)', { count: 'exact' })
    .eq('artwork_id', artworkId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load reviews.', 500, 'QUERY_FAILED');
  return { items: data.map(anonymize), total: count, page, pageSize };
}

async function listForArtist(artistId, { page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('reviews')
    .select('id, rating, packaging_rating, delivery_rating, comment, created_at, artwork_id, users:buyer_id(full_name)', { count: 'exact' })
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load reviews.', 500, 'QUERY_FAILED');
  return { items: data.map(anonymize), total: count, page, pageSize };
}

function anonymize(review) {
  const firstName = review.users?.full_name ? review.users.full_name.split(' ')[0] : 'Collector';
  const { users, ...rest } = review;
  return { ...rest, buyerFirstName: firstName };
}

async function report(reportedBy, reviewId, reason) {
  if (!reason || reason.trim().length < 3) throw new AppError('A reason is required.', 422, 'VALIDATION_ERROR');

  const { data: review, error: reviewError } = await supabaseAdmin
    .from('reviews').select('id').eq('id', reviewId).maybeSingle();
  if (reviewError || !review) throw new AppError('Review not found.', 404, 'NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('review_reports')
    .insert({ review_id: reviewId, reported_by: reportedBy, reason })
    .select('*')
    .single();
  if (error) throw new AppError('Could not submit report.', 500, 'INSERT_FAILED');

  await supabaseAdmin.from('reviews').update({ is_reported: true }).eq('id', reviewId);
  return data;
}

// ---- Admin moderation ----

async function listReported({ status = 'open', page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('review_reports')
    .select('*, reviews(*, users:buyer_id(full_name, email)), reporter:reported_by(full_name, email)', { count: 'exact' })
    .eq('status', status)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load review reports.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function dismissReport(reportId, adminId) {
  const { data, error } = await supabaseAdmin
    .from('review_reports')
    .update({ status: 'dismissed', resolved_by: adminId, resolved_at: new Date().toISOString() })
    .eq('id', reportId)
    .eq('status', 'open')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not dismiss report.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only open reports can be dismissed.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function removeReview(reviewId, adminId, reportId = null) {
  const { error } = await supabaseAdmin.from('reviews').delete().eq('id', reviewId);
  if (error) throw new AppError('Could not remove review.', 500, 'DELETE_FAILED');

  if (reportId) {
    await supabaseAdmin
      .from('review_reports')
      .update({ status: 'actioned', resolved_by: adminId, resolved_at: new Date().toISOString() })
      .eq('id', reportId);
  } else {
    // Removing a review admin found some other way — close out any open reports on it too.
    await supabaseAdmin
      .from('review_reports')
      .update({ status: 'actioned', resolved_by: adminId, resolved_at: new Date().toISOString() })
      .eq('review_id', reviewId)
      .eq('status', 'open');
  }
}

module.exports = {
  create, listForArtwork, listForArtist, report,
  listReported, dismissReport, removeReview,
};
