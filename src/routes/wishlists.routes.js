const router = require('express').Router();
const wishlistController = require('../controllers/wishlistController');
const { authenticate } = require('../middleware/auth');

// Public — shared wishlist view (spec section 13: "share collections")
router.get('/shared/:token', wishlistController.getShared);

router.use(authenticate);

router.get('/', wishlistController.listMine);
router.post('/', wishlistController.create);
router.post('/:id/share', wishlistController.share);
router.post('/items/:artworkId', wishlistController.addItem);
router.delete('/items/:artworkId', wishlistController.removeItem);

module.exports = router;
