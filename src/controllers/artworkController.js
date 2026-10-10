const asyncHandler = require('../utils/asyncHandler');
const artworkService = require('../services/artworkService');
const uploadService = require('../services/uploadService');
const feeService = require('../services/feeService');
const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

// Shared helper: resolve the caller's own approved artist_profile id.
// Every artist-dashboard endpoint below derives ownership from this,
// never from anything the client sends.
async function getOwnArtistProfile(userId) {
  const { data: artistProfile, error } = await supabaseAdmin
    .from('artist_profiles')
    .select('id, status')
    .eq('user_id', userId)
    .single();

  if (error || !artistProfile) throw new AppError('Artist profile not found.', 404, 'NOT_FOUND');
  return artistProfile;
}

const list = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 24, sort = 'newest', category, medium, style, artist,
          country, type, framed, featured, minPrice, maxPrice, q } = req.query;

  const result = await artworkService.listPublished({
    page: parseInt(page, 10),
    pageSize: Math.min(parseInt(pageSize, 10) || 24, 60),
    sort,
    filters: {
      categoryId: category, mediumId: medium, styleId: style, artistId: artist,
      country, artworkType: type,
      isFramed: framed === undefined ? undefined : framed === 'true',
      isFeatured: featured === 'true',
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      search: q,
    },
  });

  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getOne = asyncHandler(async (req, res) => {
  const artwork = await artworkService.getBySlug(req.params.slug);
  res.json({ data: artwork });
});

// Artist-only: create a new artwork draft under their own profile.
const create = asyncHandler(async (req, res) => {
  const { data: artistProfile, error } = await supabaseAdmin
    .from('artist_profiles')
    .select('id, status')
    .eq('user_id', req.user.id)
    .single();

  if (error || !artistProfile) throw new AppError('Artist profile not found.', 404, 'NOT_FOUND');
  if (artistProfile.status !== 'approved') {
    throw new AppError('Your artist account must be approved before you can list artwork.', 403, 'ARTIST_NOT_APPROVED');
  }

  const artwork = await artworkService.createDraft(artistProfile.id, req.body);
  res.status(201).json({ data: artwork });
});

const submitForReview = asyncHandler(async (req, res) => {
  // req.artwork was loaded and ownership-checked by requireArtworkOwnership
  const artistProfile = await getOwnArtistProfile(req.user.id);

  // FEE GATEWAY: "artwork_upload" — if admin has an active fee configured
  // for listing artwork, it must be settled before the artwork can move
  // to PENDING_REVIEW. If no fee is configured, getOrCreateCharge returns
  // null and submission proceeds exactly as before (free).
  const charge = await feeService.getOrCreateCharge({
    feeTypeCode: 'artwork_upload',
    userId: req.user.id,
    relatedEntityType: 'artwork',
    relatedEntityId: req.params.id,
    artistId: artistProfile.id,
    categoryId: req.artwork.category_id,
    baseAmount: req.artwork.price,
    currency: req.artwork.currency,
  });

  if (!feeService.isSettled(charge)) {
    throw Object.assign(
      new AppError('An artwork listing fee must be paid before this artwork can be submitted for review.', 402, 'FEE_PAYMENT_REQUIRED'),
      { feeCharge: charge }
    );
  }

  const artwork = await artworkService.submitForReview(req.params.id);
  res.json({ data: artwork });
});

// ---------------------------------------------------------------------
// Artist dashboard — "My Artworks" management (spec section 11)
// ---------------------------------------------------------------------

const listMine = asyncHandler(async (req, res) => {
  const artistProfile = await getOwnArtistProfile(req.user.id);
  const { status, page = 1, pageSize = 24 } = req.query;

  const result = await artworkService.listForArtist(artistProfile.id, {
    status,
    page: parseInt(page, 10),
    pageSize: Math.min(parseInt(pageSize, 10) || 24, 60),
  });

  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getMine = asyncHandler(async (req, res) => {
  const artistProfile = await getOwnArtistProfile(req.user.id);
  const artwork = await artworkService.getOwnedById(req.params.id, artistProfile.id);
  res.json({ data: artwork });
});

const update = asyncHandler(async (req, res) => {
  // req.artwork was ownership-checked by requireArtworkOwnership middleware
  const artistProfile = await getOwnArtistProfile(req.user.id);
  const artwork = await artworkService.updateOwned(req.params.id, artistProfile.id, req.body);
  res.json({ data: artwork });
});

const unpublish = asyncHandler(async (req, res) => {
  const artistProfile = await getOwnArtistProfile(req.user.id);
  const artwork = await artworkService.unpublish(req.params.id, artistProfile.id);
  res.json({ data: artwork });
});

const archive = asyncHandler(async (req, res) => {
  const artistProfile = await getOwnArtistProfile(req.user.id);
  const artwork = await artworkService.archive(req.params.id, artistProfile.id);
  res.json({ data: artwork });
});

const markUnavailable = asyncHandler(async (req, res) => {
  const artistProfile = await getOwnArtistProfile(req.user.id);
  const artwork = await artworkService.markUnavailable(req.params.id, artistProfile.id);
  res.json({ data: artwork });
});

const uploadImages = asyncHandler(async (req, res) => {
  if (!req.files || req.files.length === 0) throw new AppError('No files uploaded.', 400, 'FILE_REQUIRED');

  const artistProfile = await getOwnArtistProfile(req.user.id);
  await artworkService.getOwnedById(req.params.id, artistProfile.id); // ownership check

  const imageType = req.body.imageType || 'gallery'; // main, gallery, detail, signature, certificate
  const uploaded = [];
  for (const file of req.files) {
    const result = await uploadService.uploadArtworkImage(file, { artistProfileId: artistProfile.id, artworkId: req.params.id });
    uploaded.push({ imageType, ...result });
  }

  const images = await artworkService.addImages(req.params.id, artistProfile.id, uploaded);
  res.status(201).json({ data: images });
});

const removeImage = asyncHandler(async (req, res) => {
  const artistProfile = await getOwnArtistProfile(req.user.id);
  await artworkService.removeImage(req.params.imageId, req.params.id, artistProfile.id);
  res.status(204).send();
});

module.exports = {
  list, getOne, create, submitForReview,
  listMine, getMine, update, unpublish, archive, markUnavailable,
  uploadImages, removeImage,
};
