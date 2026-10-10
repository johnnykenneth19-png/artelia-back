const router = require('express').Router();
const cartController = require('../controllers/cartController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

// Cart is a buyer-facing concept; artists/admins operate through their
// own dashboards, not the shopping cart.
router.use(authenticate);

router.get('/', cartController.listMine);
router.post('/items', cartController.addItem);
router.delete('/items/:artworkId', cartController.removeItem);
router.delete('/', cartController.clear);

module.exports = router;
