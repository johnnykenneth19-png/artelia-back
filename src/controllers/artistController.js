const asyncHandler = require('../utils/asyncHandler');
const artistService = require('../services/artistService');
const uploadService = require('../services/uploadService');
const followService = require('../services/followService');
const AppError = require('../utils/AppError');
const config = require('../config');

const applyAsArtist = asyncHandler(async (req, res) => {
  const profile = await artistService.applyAsArtist(req.user.id, req.body);
  res.status(201).json({
    data: profile,
    message: 'Application submitted. Our team will review it and follow up on next steps.',
  });
});

const getMyProfile = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');
  res.json({ data: profile });
});

const getPublicProfile = asyncHandler(async (req, res) => {
  const profile = await artistService.getPublicProfileBySlug(req.params.slug);
  res.json({ data: profile });
});

const updateMyProfile = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const updated = await artistService.updateProfile(profile.id, req.body);
  res.json({ data: updated });
});

const getPayoutAccount = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');
  const account = await artistService.getPayoutAccount(profile.id);
  res.json({ data: account });
});

const updatePayoutAccount = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const { bankName, bankCode, accountName, accountNumber, currency } = req.body;
  if (!bankCode || !accountName || !accountNumber) {
    throw new AppError('Bank code, account name, and account number are required.', 422, 'VALIDATION_ERROR');
  }

  const account = await artistService.upsertPayoutAccount(profile.id, { bankName, bankCode, accountName, accountNumber, currency });
  res.json({ data: account, message: 'Payout account saved. It will be re-verified before your next withdrawal is processed.' });
});

const getDashboard = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const overview = await artistService.getDashboardOverview(profile.id, config.platform.baseCurrency, req.user.id);
  res.json({ data: overview });
});

const uploadVerificationDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('No file uploaded.', 400, 'FILE_REQUIRED');

  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const { documentType } = req.body;
  const allowedTypes = ['government_id', 'selfie', 'proof_of_address', 'other'];
  if (!allowedTypes.includes(documentType)) {
    throw new AppError('Invalid document type.', 422, 'VALIDATION_ERROR');
  }

  const result = await uploadService.uploadVerificationDocument(req.file, { userId: req.user.id, documentType });

  const { supabaseAdmin } = require('../config/supabase');
  const { data: verification } = await supabaseAdmin
    .from('artist_verifications')
    .select('id')
    .eq('artist_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (verification) {
    await supabaseAdmin.from('verification_documents').insert({
      verification_id: verification.id,
      document_type: documentType,
      file_url: result.storagePath, // storage path, not a public URL — accessed only via signed URLs
    });
  }

  res.status(201).json({ data: { uploaded: true } });
});

// ---------------------------------------------------------------------
// Artist follow (spec sections 8, 12, 14)
// ---------------------------------------------------------------------

const follow = asyncHandler(async (req, res) => {
  const result = await followService.follow(req.user.id, req.params.id);
  res.status(201).json({ data: result });
});

const unfollow = asyncHandler(async (req, res) => {
  await followService.unfollow(req.user.id, req.params.id);
  res.status(204).send();
});

/** Buyer dashboard: "Followed artists" (spec section 12). */
const listFollowing = asyncHandler(async (req, res) => {
  const data = await followService.listFollowing(req.user.id);
  res.json({ data });
});

/** Artist-only: who follows them — the count alone is public via the profile; the list itself is not. */
const listMyFollowers = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('Artist profile not found.', 404, 'NOT_FOUND');
  const { page = 1, pageSize = 30 } = req.query;
  const result = await followService.listFollowers(profile.id, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

module.exports = {
  applyAsArtist, getMyProfile, getPublicProfile, updateMyProfile, getDashboard, uploadVerificationDocument,
  getPayoutAccount, updatePayoutAccount,
  follow, unfollow, listFollowing, listMyFollowers,
};
