const router = require('express').Router();
const artistController = require('../controllers/artistController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { singleDocument } = require('../middleware/upload');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { applyArtistSchema } = require('../validation/schemas');

// ---- Onboarding ("Become an Artist", spec section 9) ----
router.post('/apply', authenticate, validate(applyArtistSchema), artistController.applyAsArtist);
router.post(
  '/verification-documents',
  authenticate,
  sensitiveActionLimiter,
  singleDocument,
  artistController.uploadVerificationDocument
);

// ---- Own dashboard (must precede /:slug) ----
router.get('/me', authenticate, requireRole('artist'), artistController.getMyProfile);
router.patch('/me', authenticate, requireRole('artist'), artistController.updateMyProfile);
router.get('/me/dashboard', authenticate, requireRole('artist'), artistController.getDashboard);
router.get('/me/payout-account', authenticate, requireRole('artist'), artistController.getPayoutAccount);
router.put('/me/payout-account', authenticate, requireRole('artist'), sensitiveActionLimiter, artistController.updatePayoutAccount);

// ---- Follow (spec sections 8, 12, 14) ----
router.get('/me/following', authenticate, artistController.listFollowing);
router.get('/me/followers', authenticate, requireRole('artist'), artistController.listMyFollowers);
router.post('/:id/follow', authenticate, artistController.follow);
router.delete('/:id/follow', authenticate, artistController.unfollow);

// ---- Public artist profile ----
router.get('/:slug', artistController.getPublicProfile);

module.exports = router;
