const router = require('express').Router();
const orderController = require('../controllers/orderController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

router.use(authenticate);

router.post('/checkout', sensitiveActionLimiter, orderController.checkout);
router.get('/artist/mine', requireRole('artist'), orderController.listForArtist);
router.get('/', orderController.listMine);
router.get('/:id', orderController.getOne);
router.post('/:id/verify-payment', orderController.verifyPayment);
router.post('/:id/cancel', sensitiveActionLimiter, orderController.cancel);

module.exports = router;
