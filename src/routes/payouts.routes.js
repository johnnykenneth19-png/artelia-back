const router = require('express').Router();
const payoutController = require('../controllers/payoutController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

router.use(authenticate, requireRole('artist'));

router.get('/', payoutController.listMine);
router.post('/', sensitiveActionLimiter, payoutController.requestPayout);

module.exports = router;
