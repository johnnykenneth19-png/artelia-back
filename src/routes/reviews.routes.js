const router = require('express').Router();
const reviewController = require('../controllers/reviewController');
const { authenticate } = require('../middleware/auth');

// Public read access (spec section 33: buyers browse reviews before purchasing).
router.get('/artwork/:artworkId', reviewController.listForArtwork);
router.get('/artist/:artistId', reviewController.listForArtist);

// Any authenticated user may review a purchase they made — not gated by
// primary_role, since an artist/gallery account can also buy artwork.
// Verification is from their real order history (reviewService), not a
// client-supplied flag or role.
router.post('/', authenticate, reviewController.create);
router.post('/:id/report', authenticate, reviewController.report);

module.exports = router;
