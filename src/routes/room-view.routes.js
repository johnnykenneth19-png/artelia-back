const router = require('express').Router();
const roomViewController = require('../controllers/roomViewController');
const { authenticate } = require('../middleware/auth');
const { singleImage } = require('../middleware/upload');

// Spec section 37 — "View Artwork in Room" — architecture only (see
// roomViewService.js). All routes require auth: a room photo is personal.
router.use(authenticate);

router.get('/mine', roomViewController.listMine);
router.post('/', singleImage, roomViewController.submitRequest);
router.get('/:id', roomViewController.getRequest);

module.exports = router;
