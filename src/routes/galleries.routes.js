const router = require('express').Router();
const galleryController = require('../controllers/galleryController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// ---- Onboarding (mirrors spec section 9's artist flow) ----
router.post('/apply', authenticate, galleryController.apply);

// ---- Public directory (must precede /:slug) ----
router.get('/', galleryController.listApproved);

// ---- Own gallery dashboard (must precede /:slug) ----
router.get('/me', authenticate, galleryController.getMine);
router.post('/me/leave', authenticate, requireRole('artist'), galleryController.leaveGallery);

router.patch('/:id', authenticate, galleryController.updateProfile);
router.get('/:id/members', authenticate, galleryController.listMembers);
router.post('/:id/members', authenticate, galleryController.inviteMember);
router.patch('/:id/members/:memberId', authenticate, galleryController.updateMemberRole);
router.delete('/:id/members/:memberId', authenticate, galleryController.removeMember);

router.post('/:id/join', authenticate, requireRole('artist'), galleryController.joinAsArtist);
router.get('/:id/artists', galleryController.listArtists);
router.get('/:id/inventory', authenticate, galleryController.listInventory);
router.get('/:id/analytics', authenticate, galleryController.getAnalytics);

// ---- Public gallery profile ----
router.get('/:slug', galleryController.getPublic);

module.exports = router;
