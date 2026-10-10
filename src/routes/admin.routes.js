const router = require('express').Router();
const adminController = require('../controllers/adminController');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');

// Every route here requires BOTH a valid session AND an admin_users row.
// requireAdmin() with no args = any admin role; pass specific roles to
// restrict further (e.g. requireAdmin('super_admin','finance_admin')).
router.use(authenticate, requireAdmin());

// ---- Artwork moderation (spec section 30) ----
router.get('/artworks/pending', adminController.listPendingArtworks);
router.post('/artworks/:id/approve', adminController.approveArtwork);
router.post('/artworks/:id/publish', adminController.publishArtwork);
router.post('/artworks/:id/reject', adminController.rejectArtwork);
router.post('/artworks/:id/unpublish', adminController.unpublishArtwork);

// ---- Artist approval (spec section 29, minimal slice) ----
router.get('/artists/pending', adminController.listPendingArtists);
router.post('/artists/:id/approve', adminController.approveArtist);
router.post('/artists/:id/reject', adminController.rejectArtist);

// ---- Gallery approval (spec section 39, Phase 9) ----
router.get('/galleries/pending', adminController.listPendingGalleries);
router.post('/galleries/:id/approve', adminController.approveGallery);
router.post('/galleries/:id/reject', adminController.rejectGallery);
router.post('/galleries/:id/suspend', adminController.suspendGallery);

// ---- Fee management (finance_admin / super_admin only) ----
const financeOnly = requireAdmin('super_admin', 'finance_admin');

router.get('/fees/types', financeOnly, adminController.listFeeTypes);
router.post('/fees/types', financeOnly, adminController.createFeeType);
router.patch('/fees/types/:id', financeOnly, adminController.updateFeeType);

router.post('/fees/rules', financeOnly, adminController.createFeeRule);
router.patch('/fees/rules/:id', financeOnly, adminController.updateFeeRule);
router.delete('/fees/rules/:id', financeOnly, adminController.deleteFeeRule);

router.get('/fees/destinations', financeOnly, adminController.listPaymentDestinations);
router.post('/fees/destinations', financeOnly, adminController.createPaymentDestination);
router.patch('/fees/destinations/:id', financeOnly, adminController.updatePaymentDestination);

router.get('/fees/charges', financeOnly, adminController.listFeeCharges);
router.post('/fees/charges/:id/verify', financeOnly, adminController.verifyFeeCharge);
router.post('/fees/charges/:id/waive', financeOnly, adminController.waiveFeeCharge);

// ---- Payouts (finance_admin / super_admin only) ----
router.get('/payouts', financeOnly, adminController.listPayouts);
router.post('/payouts/:id/initiate-transfer', financeOnly, adminController.initiatePayoutTransfer);
router.post('/payouts/:id/mark-processed', financeOnly, adminController.markPayoutProcessed);
router.post('/payouts/:id/mark-failed', financeOnly, adminController.markPayoutFailed);

// ---- Reconciliation (finance_admin / super_admin only) ----
router.post('/reconciliation/run', financeOnly, adminController.runReconciliation);
router.get('/reconciliation/flags', financeOnly, adminController.listReconciliationFlags);
router.post('/reconciliation/flags/:id/resolve', financeOnly, adminController.resolveReconciliationFlag);
router.post('/reconciliation/flags/:id/dismiss', financeOnly, adminController.dismissReconciliationFlag);

// ---- Disputes: any admin can view/start review, only finance/super can resolve (moves money) ----
router.get('/disputes', adminController.listDisputes);
router.post('/disputes/:id/start-review', adminController.startDisputeReview);
router.post('/disputes/:id/resolve', financeOnly, adminController.resolveDispute);
router.post('/disputes/:id/reject', adminController.rejectDispute);

// ---- Reporting & analytics (spec sections 28, 58) — any admin role ----
router.get('/reports/overview', adminController.getDashboardOverview);
router.get('/reports/sales', adminController.getSalesReport);
router.get('/reports/top-artists', adminController.getTopArtists);
router.get('/reports/top-artworks', adminController.getTopArtworks);
router.get('/reports/artist-earnings', financeOnly, adminController.getArtistEarningsReport);
router.get('/reports/refunds', financeOnly, adminController.getRefundsReport);
router.get('/reports/conversion', adminController.getConversionReport);
router.get('/reports/disputes', adminController.getDisputesReport);

// ---- Review moderation (spec section 33) ----
router.get('/reviews/reported', adminController.listReportedReviews);
router.post('/reviews/reports/:id/dismiss', adminController.dismissReviewReport);
router.delete('/reviews/:reviewId', adminController.removeReview);

// ---- Collections CMS (spec section 35) ----
router.get('/collections', adminController.listCollections);
router.post('/collections', adminController.createCollection);
router.patch('/collections/:id', adminController.updateCollection);
router.delete('/collections/:id', adminController.deleteCollection);
router.post('/collections/:id/artworks', adminController.addCollectionArtwork);
router.delete('/collections/:id/artworks/:artworkId', adminController.removeCollectionArtwork);

// ---- Exhibitions CMS (spec section 36) ----
router.get('/exhibitions', adminController.listExhibitions);
router.post('/exhibitions', adminController.createExhibition);
router.patch('/exhibitions/:id', adminController.updateExhibition);
router.delete('/exhibitions/:id', adminController.deleteExhibition);
router.post('/exhibitions/:id/artworks', adminController.addExhibitionArtwork);
router.delete('/exhibitions/:id/artworks/:artworkId', adminController.removeExhibitionArtwork);

// ---- Blog / editorial (spec section 43) ----
router.get('/blog', adminController.listBlogPosts);
router.post('/blog', adminController.createBlogPost);
router.patch('/blog/:id', adminController.updateBlogPost);
router.delete('/blog/:id', adminController.deleteBlogPost);

// ---- Marketing (spec section 44) ----
router.patch('/artworks/:id/featured', adminController.setArtworkFeatured);
router.patch('/artists/:id/featured', adminController.setArtistFeatured);
router.get('/marketing/homepage-sections', adminController.getHomepageSections);
router.patch('/marketing/homepage-sections', adminController.updateHomepageSections);

router.get('/marketing/discount-codes', financeOnly, adminController.listDiscountCodes);
router.post('/marketing/discount-codes', financeOnly, adminController.createDiscountCode);
router.patch('/marketing/discount-codes/:id', financeOnly, adminController.updateDiscountCode);

router.get('/marketing/newsletter-subscribers', adminController.listNewsletterSubscribers);
router.get('/marketing/campaigns', adminController.listEmailCampaigns);
router.post('/marketing/campaigns', adminController.createEmailCampaign);
router.post('/marketing/campaigns/:id/queue', adminController.queueEmailCampaign);
router.post('/marketing/campaigns/:id/cancel', adminController.cancelEmailCampaign);

// ---- Admin user management (spec section 31) — super_admin only ----
const superAdminOnly = requireAdmin('super_admin');
router.get('/admins', superAdminOnly, adminController.listAdminUsers);
router.post('/admins', superAdminOnly, adminController.grantAdminRole);
router.patch('/admins/:id', superAdminOnly, adminController.updateAdminRole);
router.delete('/admins/:id', superAdminOnly, adminController.revokeAdminRole);

// ---- General user management (spec section 29, generalized) ----
router.get('/users', adminController.listUsers);
router.post('/users/:id/suspend', adminController.suspendUser);
router.post('/users/:id/reactivate', adminController.reactivateUser);

module.exports = router;
