const router = require('express').Router();
const artworkController = require('../controllers/artworkController');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireArtworkOwnership } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createArtworkSchema, updateArtworkSchema } = require('../validation/schemas');
const { multipleImages } = require('../middleware/upload');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

// ---- Artist dashboard: "My Artworks" (must precede /:slug so "mine" isn't parsed as a slug) ----
router.get('/mine', authenticate, requireRole('artist'), artworkController.listMine);
router.get('/mine/:id', authenticate, requireRole('artist'), artworkController.getMine);

router.post('/', authenticate, requireRole('artist'), validate(createArtworkSchema), artworkController.create);

router.patch('/:id', authenticate, requireRole('artist'), requireArtworkOwnership, validate(updateArtworkSchema), artworkController.update);

router.post('/:id/submit-for-review', authenticate, requireRole('artist'), requireArtworkOwnership, artworkController.submitForReview);
router.post('/:id/unpublish', authenticate, requireRole('artist'), requireArtworkOwnership, artworkController.unpublish);
router.post('/:id/archive', authenticate, requireRole('artist'), requireArtworkOwnership, artworkController.archive);
router.post('/:id/mark-unavailable', authenticate, requireRole('artist'), requireArtworkOwnership, artworkController.markUnavailable);

router.post(
  '/:id/images',
  authenticate,
  requireRole('artist'),
  requireArtworkOwnership,
  sensitiveActionLimiter,
  multipleImages,
  artworkController.uploadImages
);
router.delete('/:id/images/:imageId', authenticate, requireRole('artist'), requireArtworkOwnership, artworkController.removeImage);

// ---- Public catalog (kept last so specific paths above win) ----
router.get('/', artworkController.list);
router.get('/:slug', artworkController.getOne);

module.exports = router;
