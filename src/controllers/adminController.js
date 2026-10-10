const asyncHandler = require('../utils/asyncHandler');
const artworkService = require('../services/artworkService');
const feeService = require('../services/feeService');
const payoutService = require('../services/payoutService');
const reconciliationService = require('../services/reconciliationService');
const disputeService = require('../services/disputeService');
const reportingService = require('../services/reportingService');
const reviewService = require('../services/reviewService');
const collectionService = require('../services/collectionService');
const exhibitionService = require('../services/exhibitionService');
const blogService = require('../services/blogService');
const marketingService = require('../services/marketingService');
const adminUserService = require('../services/adminUserService');
const galleryService = require('../services/galleryService');
const AppError = require('../utils/AppError');
const { supabaseAdmin } = require('../config/supabase');

// ---------------------------------------------------------------------
// Artwork moderation (spec section 30)
// ---------------------------------------------------------------------

const listPendingArtworks = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 24 } = req.query;
  const result = await artworkService.listPendingReview({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const approveArtwork = asyncHandler(async (req, res) => {
  const artwork = await artworkService.approve(req.params.id, req.user.id);
  await logAdminAction(req, 'artwork.approve', 'artwork', req.params.id);
  res.json({ data: artwork });
});

const publishArtwork = asyncHandler(async (req, res) => {
  const artwork = await artworkService.publish(req.params.id, req.user.id);
  await logAdminAction(req, 'artwork.publish', 'artwork', req.params.id);
  res.json({ data: artwork });
});

const rejectArtwork = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.trim().length < 5) {
    throw new AppError('A rejection reason is required.', 422, 'VALIDATION_ERROR');
  }
  const artwork = await artworkService.reject(req.params.id, req.user.id, reason);
  await logAdminAction(req, 'artwork.reject', 'artwork', req.params.id, { reason });
  res.json({ data: artwork });
});

const unpublishArtwork = asyncHandler(async (req, res) => {
  const artwork = await artworkService.adminUnpublish(req.params.id, req.user.id);
  await logAdminAction(req, 'artwork.unpublish', 'artwork', req.params.id);
  res.json({ data: artwork });
});

// ---------------------------------------------------------------------
// Artist approval (spec section 29) — minimal slice needed to unblock
// the artwork pipeline; full artist admin (suspend/reactivate/document
// review UI) belongs to Phase 8.
// ---------------------------------------------------------------------

const listPendingArtists = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('artist_profiles')
    .select('id, artist_name, slug, location, country, status, created_at, users:user_id ( email, full_name )')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Could not load pending artists.', 500, 'QUERY_FAILED');
  res.json({ data });
});

const approveArtist = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('artist_profiles')
    .update({ status: 'approved', is_verified: true })
    .eq('id', req.params.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not approve artist.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only pending artists can be approved.', 400, 'INVALID_STATE_TRANSITION');

  await supabaseAdmin
    .from('artist_verifications')
    .update({ status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('artist_id', req.params.id)
    .eq('status', 'pending');

  await logAdminAction(req, 'artist.approve', 'artist_profile', req.params.id);
  res.json({ data });
});

const rejectArtist = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.trim().length < 5) {
    throw new AppError('A rejection reason is required.', 422, 'VALIDATION_ERROR');
  }

  const { data, error } = await supabaseAdmin
    .from('artist_profiles')
    .update({ status: 'rejected' })
    .eq('id', req.params.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not reject artist.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only pending artists can be rejected.', 400, 'INVALID_STATE_TRANSITION');

  await supabaseAdmin
    .from('artist_verifications')
    .update({ status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), rejection_reason: reason })
    .eq('artist_id', req.params.id)
    .eq('status', 'pending');

  await logAdminAction(req, 'artist.reject', 'artist_profile', req.params.id, { reason });
  res.json({ data });
});

// ---------------------------------------------------------------------
// Gallery approval (spec section 39, Phase 9) — mirrors artist approval exactly.
// ---------------------------------------------------------------------

const listPendingGalleries = asyncHandler(async (req, res) => {
  const data = await galleryService.listPending();
  res.json({ data });
});

const approveGallery = asyncHandler(async (req, res) => {
  const gallery = await galleryService.approve(req.params.id);
  await logAdminAction(req, 'gallery.approve', 'gallery_profile', req.params.id);
  res.json({ data: gallery });
});

const rejectGallery = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.trim().length < 5) throw new AppError('A rejection reason is required.', 422, 'VALIDATION_ERROR');
  const gallery = await galleryService.reject(req.params.id, reason);
  await logAdminAction(req, 'gallery.reject', 'gallery_profile', req.params.id, { reason });
  res.json({ data: gallery });
});

const suspendGallery = asyncHandler(async (req, res) => {
  const gallery = await galleryService.suspend(req.params.id);
  await logAdminAction(req, 'gallery.suspend', 'gallery_profile', req.params.id);
  res.json({ data: gallery });
});

// ---------------------------------------------------------------------
// FEE MANAGEMENT (finance_admin / super_admin) — spec: admin can set any
// kind of fee at any point, and choose how it's collected. This is the
// full configuration surface on top of feeService's engine.
// ---------------------------------------------------------------------

const listFeeTypes = asyncHandler(async (req, res) => {
  const data = await feeService.listFeeTypes();
  res.json({ data });
});

const createFeeType = asyncHandler(async (req, res) => {
  const { code, name, description } = req.body;
  if (!code || !name) throw new AppError('A fee code and name are required.', 422, 'VALIDATION_ERROR');
  const feeType = await feeService.createFeeType(req.user.id, { code, name, description });
  await logAdminAction(req, 'fee_type.create', 'fee_type', feeType.id, { code, name });
  res.status(201).json({ data: feeType });
});

const updateFeeType = asyncHandler(async (req, res) => {
  const feeType = await feeService.updateFeeType(req.params.id, req.body);
  await logAdminAction(req, 'fee_type.update', 'fee_type', req.params.id, req.body);
  res.json({ data: feeType });
});

const createFeeRule = asyncHandler(async (req, res) => {
  const { fee_type_id, calculation_type } = req.body;
  if (!fee_type_id || !calculation_type) {
    throw new AppError('fee_type_id and calculation_type are required.', 422, 'VALIDATION_ERROR');
  }
  const rule = await feeService.createFeeRule(req.user.id, req.body);
  await logAdminAction(req, 'fee_rule.create', 'fee_rule', rule.id, req.body);
  res.status(201).json({ data: rule });
});

const updateFeeRule = asyncHandler(async (req, res) => {
  const rule = await feeService.updateFeeRule(req.params.id, req.body);
  await logAdminAction(req, 'fee_rule.update', 'fee_rule', req.params.id, req.body);
  res.json({ data: rule });
});

const deleteFeeRule = asyncHandler(async (req, res) => {
  await feeService.deleteFeeRule(req.params.id);
  await logAdminAction(req, 'fee_rule.deactivate', 'fee_rule', req.params.id);
  res.status(204).send();
});

const listPaymentDestinations = asyncHandler(async (req, res) => {
  const data = await feeService.listPaymentDestinations({ includeInactive: true });
  res.json({ data });
});

const createPaymentDestination = asyncHandler(async (req, res) => {
  const { type, label } = req.body;
  if (!type || !label) throw new AppError('A destination type and label are required.', 422, 'VALIDATION_ERROR');
  const destination = await feeService.createPaymentDestination(req.user.id, req.body);
  await logAdminAction(req, 'payment_destination.create', 'admin_payment_destination', destination.id, { type, label });
  res.status(201).json({ data: destination });
});

const updatePaymentDestination = asyncHandler(async (req, res) => {
  const destination = await feeService.updatePaymentDestination(req.params.id, req.body);
  await logAdminAction(req, 'payment_destination.update', 'admin_payment_destination', req.params.id, req.body);
  res.json({ data: destination });
});

const listFeeCharges = asyncHandler(async (req, res) => {
  const { status, page = 1, pageSize = 30 } = req.query;
  const result = await feeService.listAllCharges({ status, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const verifyFeeCharge = asyncHandler(async (req, res) => {
  const { approve, note } = req.body;
  const charge = await feeService.verifyManualPayment(req.params.id, req.user.id, !!approve, note);
  await logAdminAction(req, approve ? 'fee_charge.verify_approve' : 'fee_charge.verify_reject', 'fee_charge', req.params.id, { note });
  res.json({ data: charge });
});

const waiveFeeCharge = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) throw new AppError('A reason is required to waive a fee.', 422, 'VALIDATION_ERROR');
  const charge = await feeService.waiveCharge(req.params.id, req.user.id, reason);
  await logAdminAction(req, 'fee_charge.waive', 'fee_charge', req.params.id, { reason });
  res.json({ data: charge });
});

// ---------------------------------------------------------------------
// Payouts (finance_admin / super_admin) — spec section 25
// ---------------------------------------------------------------------

const initiatePayoutTransfer = asyncHandler(async (req, res) => {
  const payout = await payoutService.initiateProviderTransfer(req.params.id);
  await logAdminAction(req, 'payout.initiate_transfer', 'payout', req.params.id, { status: payout.status, providerReference: payout.provider_reference });
  res.json({ data: payout });
});

const listPayouts = asyncHandler(async (req, res) => {
  const { status, page = 1, pageSize = 30 } = req.query;
  const result = await payoutService.listAll({ status, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const markPayoutProcessed = asyncHandler(async (req, res) => {
  const { providerReference } = req.body;
  const payout = await payoutService.markProcessed(req.params.id, providerReference);
  await logAdminAction(req, 'payout.mark_processed', 'payout', req.params.id, { providerReference });
  res.json({ data: payout });
});

const markPayoutFailed = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) throw new AppError('A reason is required.', 422, 'VALIDATION_ERROR');
  const payout = await payoutService.markFailed(req.params.id, reason);
  await logAdminAction(req, 'payout.mark_failed', 'payout', req.params.id, { reason });
  res.json({ data: payout });
});

// ---------------------------------------------------------------------
// Reconciliation (finance_admin / super_admin) — spec section 51
// ---------------------------------------------------------------------

const runReconciliation = asyncHandler(async (req, res) => {
  const [pendingSummary, finalizedSummary] = await Promise.all([
    reconciliationService.reconcilePendingPayments(),
    reconciliationService.reconcileFinalizedOrders(),
  ]);
  await logAdminAction(req, 'reconciliation.run', 'system', null, { pendingSummary, finalizedSummary });
  res.json({ data: { pendingPayments: pendingSummary, finalizedOrders: finalizedSummary } });
});

const listReconciliationFlags = asyncHandler(async (req, res) => {
  const { status = 'open', page = 1, pageSize = 30 } = req.query;
  const result = await reconciliationService.listFlags({ status, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const resolveReconciliationFlag = asyncHandler(async (req, res) => {
  const flag = await reconciliationService.resolveFlag(req.params.id, req.user.id, req.body.notes);
  await logAdminAction(req, 'reconciliation_flag.resolve', 'reconciliation_flag', req.params.id, { notes: req.body.notes });
  res.json({ data: flag });
});

const dismissReconciliationFlag = asyncHandler(async (req, res) => {
  const flag = await reconciliationService.dismissFlag(req.params.id, req.user.id, req.body.notes);
  await logAdminAction(req, 'reconciliation_flag.dismiss', 'reconciliation_flag', req.params.id, { notes: req.body.notes });
  res.json({ data: flag });
});

// ---------------------------------------------------------------------
// Disputes (any admin role can review; resolution requires finance/super
// since it can move money — enforced at the route level)
// ---------------------------------------------------------------------

const listDisputes = asyncHandler(async (req, res) => {
  const { status, page = 1, pageSize = 30 } = req.query;
  const result = await disputeService.listAll({ status, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const startDisputeReview = asyncHandler(async (req, res) => {
  const dispute = await disputeService.startReview(req.params.id, req.user.id);
  await logAdminAction(req, 'dispute.start_review', 'dispute', req.params.id);
  res.json({ data: dispute });
});

const resolveDispute = asyncHandler(async (req, res) => {
  const { resolutionType, refundAmount, notes } = req.body;
  if (!resolutionType) throw new AppError('A resolution type is required.', 422, 'VALIDATION_ERROR');
  const dispute = await disputeService.resolve(req.params.id, req.user.id, { resolutionType, refundAmount, notes });
  await logAdminAction(req, 'dispute.resolve', 'dispute', req.params.id, { resolutionType, refundAmount, notes });
  res.json({ data: dispute });
});

const rejectDispute = asyncHandler(async (req, res) => {
  const { notes } = req.body;
  const dispute = await disputeService.reject(req.params.id, req.user.id, notes);
  await logAdminAction(req, 'dispute.reject', 'dispute', req.params.id, { notes });
  res.json({ data: dispute });
});

// ---------------------------------------------------------------------
// Reporting & analytics (spec sections 28, 58) — any admin role may view.
// ---------------------------------------------------------------------

const getDashboardOverview = asyncHandler(async (req, res) => {
  const data = await reportingService.getDashboardOverview();
  res.json({ data });
});

const getSalesReport = asyncHandler(async (req, res) => {
  const { from, to, page = 1, pageSize = 50, format } = req.query;
  const result = await reportingService.salesReport({ from, to, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  if (format === 'csv') return sendCsv(res, 'sales-report.csv', result.items);
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getTopArtists = asyncHandler(async (req, res) => {
  const { from, to, limit = 10 } = req.query;
  const data = await reportingService.topArtists({ from, to, limit: parseInt(limit, 10) });
  res.json({ data });
});

const getTopArtworks = asyncHandler(async (req, res) => {
  const { from, to, limit = 10 } = req.query;
  const data = await reportingService.topArtworks({ from, to, limit: parseInt(limit, 10) });
  res.json({ data });
});

const getArtistEarningsReport = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 30, format } = req.query;
  const result = await reportingService.artistEarningsReport({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  if (format === 'csv') return sendCsv(res, 'artist-earnings.csv', result.items.map((i) => ({ artistId: i.artistId, name: i.name, lifetimeEarnings: i.lifetimeEarnings })));
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getRefundsReport = asyncHandler(async (req, res) => {
  const { from, to, page = 1, pageSize = 30, format } = req.query;
  const result = await reportingService.refundsReport({ from, to, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  if (format === 'csv') return sendCsv(res, 'refunds-report.csv', result.items);
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getConversionReport = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const data = await reportingService.conversionReport({ from, to });
  res.json({ data });
});

const getDisputesReport = asyncHandler(async (req, res) => {
  const data = await reportingService.disputesReport();
  res.json({ data });
});

function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(reportingService.toCsv(rows));
}

// ---------------------------------------------------------------------
// Review moderation (spec section 33)
// ---------------------------------------------------------------------

const listReportedReviews = asyncHandler(async (req, res) => {
  const { status = 'open', page = 1, pageSize = 30 } = req.query;
  const result = await reviewService.listReported({ status, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const dismissReviewReport = asyncHandler(async (req, res) => {
  const data = await reviewService.dismissReport(req.params.id, req.user.id);
  await logAdminAction(req, 'review_report.dismiss', 'review_report', req.params.id);
  res.json({ data });
});

const removeReview = asyncHandler(async (req, res) => {
  const { reportId } = req.body;
  await reviewService.removeReview(req.params.reviewId, req.user.id, reportId ?? null);
  await logAdminAction(req, 'review.remove', 'review', req.params.reviewId, { reportId });
  res.status(204).send();
});

// ---------------------------------------------------------------------
// Collections CMS (spec section 35)
// ---------------------------------------------------------------------

const listCollections = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 30 } = req.query;
  const result = await collectionService.listAll({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const createCollection = asyncHandler(async (req, res) => {
  const collection = await collectionService.create(req.user.id, req.body);
  await logAdminAction(req, 'collection.create', 'collection', collection.id, { name: collection.name });
  res.status(201).json({ data: collection });
});

const updateCollection = asyncHandler(async (req, res) => {
  const collection = await collectionService.update(req.params.id, req.body);
  await logAdminAction(req, 'collection.update', 'collection', req.params.id, req.body);
  res.json({ data: collection });
});

const deleteCollection = asyncHandler(async (req, res) => {
  await collectionService.remove(req.params.id);
  await logAdminAction(req, 'collection.delete', 'collection', req.params.id);
  res.status(204).send();
});

const addCollectionArtwork = asyncHandler(async (req, res) => {
  const { artworkId, sortOrder } = req.body;
  if (!artworkId) throw new AppError('artworkId is required.', 422, 'VALIDATION_ERROR');
  const data = await collectionService.addArtwork(req.params.id, artworkId, sortOrder ?? 0);
  await logAdminAction(req, 'collection.add_artwork', 'collection', req.params.id, { artworkId });
  res.status(201).json({ data });
});

const removeCollectionArtwork = asyncHandler(async (req, res) => {
  await collectionService.removeArtwork(req.params.id, req.params.artworkId);
  await logAdminAction(req, 'collection.remove_artwork', 'collection', req.params.id, { artworkId: req.params.artworkId });
  res.status(204).send();
});

// ---------------------------------------------------------------------
// Exhibitions CMS (spec section 36)
// ---------------------------------------------------------------------

const listExhibitions = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 30 } = req.query;
  const result = await exhibitionService.listAll({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const createExhibition = asyncHandler(async (req, res) => {
  const exhibition = await exhibitionService.create(req.user.id, req.body);
  await logAdminAction(req, 'exhibition.create', 'exhibition', exhibition.id, { title: exhibition.title });
  res.status(201).json({ data: exhibition });
});

const updateExhibition = asyncHandler(async (req, res) => {
  const exhibition = await exhibitionService.update(req.params.id, req.body);
  await logAdminAction(req, 'exhibition.update', 'exhibition', req.params.id, req.body);
  res.json({ data: exhibition });
});

const deleteExhibition = asyncHandler(async (req, res) => {
  await exhibitionService.remove(req.params.id);
  await logAdminAction(req, 'exhibition.delete', 'exhibition', req.params.id);
  res.status(204).send();
});

const addExhibitionArtwork = asyncHandler(async (req, res) => {
  const { artworkId } = req.body;
  if (!artworkId) throw new AppError('artworkId is required.', 422, 'VALIDATION_ERROR');
  const data = await exhibitionService.addArtwork(req.params.id, artworkId);
  await logAdminAction(req, 'exhibition.add_artwork', 'exhibition', req.params.id, { artworkId });
  res.status(201).json({ data });
});

const removeExhibitionArtwork = asyncHandler(async (req, res) => {
  await exhibitionService.removeArtwork(req.params.id, req.params.artworkId);
  await logAdminAction(req, 'exhibition.remove_artwork', 'exhibition', req.params.id, { artworkId: req.params.artworkId });
  res.status(204).send();
});

// ---------------------------------------------------------------------
// Blog / editorial (spec section 43)
// ---------------------------------------------------------------------

const listBlogPosts = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 30 } = req.query;
  const result = await blogService.listAll({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const createBlogPost = asyncHandler(async (req, res) => {
  const post = await blogService.create(req.user.id, req.body);
  await logAdminAction(req, 'blog_post.create', 'blog_post', post.id, { title: post.title });
  res.status(201).json({ data: post });
});

const updateBlogPost = asyncHandler(async (req, res) => {
  const post = await blogService.update(req.params.id, req.body);
  await logAdminAction(req, 'blog_post.update', 'blog_post', req.params.id, req.body);
  res.json({ data: post });
});

const deleteBlogPost = asyncHandler(async (req, res) => {
  await blogService.remove(req.params.id);
  await logAdminAction(req, 'blog_post.delete', 'blog_post', req.params.id);
  res.status(204).send();
});

// ---------------------------------------------------------------------
// Marketing (spec section 44): featured content, homepage sections,
// discount codes, newsletter, email campaigns. Finance-neutral (no
// money moves directly here, aside from discount codes shrinking a
// future order total) so any admin role may use these, not just finance.
// ---------------------------------------------------------------------

const setArtworkFeatured = asyncHandler(async (req, res) => {
  const { isFeatured } = req.body;
  const data = await marketingService.setArtworkFeatured(req.params.id, !!isFeatured);
  await logAdminAction(req, 'artwork.set_featured', 'artwork', req.params.id, { isFeatured: !!isFeatured });
  res.json({ data });
});

const setArtistFeatured = asyncHandler(async (req, res) => {
  const { isFeatured } = req.body;
  const data = await marketingService.setArtistFeatured(req.params.id, !!isFeatured);
  await logAdminAction(req, 'artist.set_featured', 'artist_profile', req.params.id, { isFeatured: !!isFeatured });
  res.json({ data });
});

const getHomepageSections = asyncHandler(async (req, res) => {
  const data = await marketingService.getHomepageSections();
  res.json({ data });
});

const updateHomepageSections = asyncHandler(async (req, res) => {
  const data = await marketingService.updateHomepageSections(req.body.sections);
  await logAdminAction(req, 'homepage_sections.update', 'settings', null, { sections: req.body.sections });
  res.json({ data });
});

const listDiscountCodes = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 30 } = req.query;
  const result = await marketingService.listDiscountCodes({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const createDiscountCode = asyncHandler(async (req, res) => {
  const code = await marketingService.createDiscountCode(req.user.id, req.body);
  await logAdminAction(req, 'discount_code.create', 'discount_code', code.id, { code: code.code });
  res.status(201).json({ data: code });
});

const updateDiscountCode = asyncHandler(async (req, res) => {
  const code = await marketingService.updateDiscountCode(req.params.id, req.body);
  await logAdminAction(req, 'discount_code.update', 'discount_code', req.params.id, req.body);
  res.json({ data: code });
});

const listNewsletterSubscribers = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 50, format } = req.query;
  const result = await marketingService.listSubscribers({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  if (format === 'csv') return sendCsv(res, 'newsletter-subscribers.csv', result.items);
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const listEmailCampaigns = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 30 } = req.query;
  const result = await marketingService.listCampaigns({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const createEmailCampaign = asyncHandler(async (req, res) => {
  const campaign = await marketingService.createCampaign(req.user.id, req.body);
  await logAdminAction(req, 'email_campaign.create', 'email_campaign', campaign.id, { name: campaign.name });
  res.status(201).json({ data: campaign });
});

const queueEmailCampaign = asyncHandler(async (req, res) => {
  const campaign = await marketingService.queueCampaign(req.params.id);
  await logAdminAction(req, 'email_campaign.queue', 'email_campaign', req.params.id);
  res.json({ data: campaign });
});

const cancelEmailCampaign = asyncHandler(async (req, res) => {
  const campaign = await marketingService.cancelCampaign(req.params.id);
  await logAdminAction(req, 'email_campaign.cancel', 'email_campaign', req.params.id);
  res.json({ data: campaign });
});

// ---------------------------------------------------------------------
// Admin user management (spec section 31) — super_admin only, enforced
// at the route level.
// ---------------------------------------------------------------------

const listAdminUsers = asyncHandler(async (req, res) => {
  const data = await adminUserService.listAdmins();
  res.json({ data });
});

const grantAdminRole = asyncHandler(async (req, res) => {
  const admin = await adminUserService.grantAdminRole(req.user.id, req.body);
  await logAdminAction(req, 'admin_user.grant', 'admin_user', admin.id, { adminRole: admin.admin_role });
  res.status(201).json({ data: admin });
});

const updateAdminRole = asyncHandler(async (req, res) => {
  const { adminRole } = req.body;
  const admin = await adminUserService.updateAdminRole(req.params.id, adminRole);
  await logAdminAction(req, 'admin_user.update_role', 'admin_user', req.params.id, { adminRole });
  res.json({ data: admin });
});

const revokeAdminRole = asyncHandler(async (req, res) => {
  await adminUserService.revokeAdmin(req.params.id, req.user.id);
  await logAdminAction(req, 'admin_user.revoke', 'admin_user', req.params.id);
  res.status(204).send();
});

const listUsers = asyncHandler(async (req, res) => {
  const { role, search, page = 1, pageSize = 30 } = req.query;
  const result = await adminUserService.listUsers({ role, search, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const suspendUser = asyncHandler(async (req, res) => {
  const data = await adminUserService.setUserActive(req.params.id, false);
  await logAdminAction(req, 'user.suspend', 'user', req.params.id);
  res.json({ data });
});

const reactivateUser = asyncHandler(async (req, res) => {
  const data = await adminUserService.setUserActive(req.params.id, true);
  await logAdminAction(req, 'user.reactivate', 'user', req.params.id);
  res.json({ data });
});

// ---------------------------------------------------------------------
// Audit logging helper — every admin action recorded (spec section 32).
// Never exposed for editing to ordinary admins; insert-only from here.
// ---------------------------------------------------------------------
async function logAdminAction(req, action, targetType, targetId, metadata = {}) {
  await supabaseAdmin.from('admin_actions').insert({
    admin_id: req.user.id, action, target_type: targetType, target_id: targetId, metadata,
  });
  await supabaseAdmin.from('audit_logs').insert({
    actor_id: req.user.id, action, target_type: targetType, target_id: targetId, metadata,
    ip_address: req.ip, user_agent: req.headers['user-agent'],
  });
}

module.exports = {
  listPendingArtworks, approveArtwork, publishArtwork, rejectArtwork, unpublishArtwork,
  listPendingArtists, approveArtist, rejectArtist,
  listPendingGalleries, approveGallery, rejectGallery, suspendGallery,
  listFeeTypes, createFeeType, updateFeeType, createFeeRule, updateFeeRule, deleteFeeRule,
  listPaymentDestinations, createPaymentDestination, updatePaymentDestination,
  listFeeCharges, verifyFeeCharge, waiveFeeCharge,
  markPayoutProcessed, markPayoutFailed, initiatePayoutTransfer, listPayouts,
  runReconciliation, listReconciliationFlags, resolveReconciliationFlag, dismissReconciliationFlag,
  listDisputes, startDisputeReview, resolveDispute, rejectDispute,
  getDashboardOverview, getSalesReport, getTopArtists, getTopArtworks,
  getArtistEarningsReport, getRefundsReport, getConversionReport, getDisputesReport,
  listReportedReviews, dismissReviewReport, removeReview,
  listCollections, createCollection, updateCollection, deleteCollection, addCollectionArtwork, removeCollectionArtwork,
  listExhibitions, createExhibition, updateExhibition, deleteExhibition, addExhibitionArtwork, removeExhibitionArtwork,
  listBlogPosts, createBlogPost, updateBlogPost, deleteBlogPost,
  setArtworkFeatured, setArtistFeatured, getHomepageSections, updateHomepageSections,
  listDiscountCodes, createDiscountCode, updateDiscountCode,
  listNewsletterSubscribers, listEmailCampaigns, createEmailCampaign, queueEmailCampaign, cancelEmailCampaign,
  listAdminUsers, grantAdminRole, updateAdminRole, revokeAdminRole,
  listUsers, suspendUser, reactivateUser,
};
