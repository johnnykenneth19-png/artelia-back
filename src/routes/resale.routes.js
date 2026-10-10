const router = require('express').Router();
const resaleController = require('../controllers/resaleController');
const { authenticate } = require('../middleware/auth');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

// ---- Authenticated (must precede the public /:id so "mine" isn't parsed as an id) ----
router.get('/mine', authenticate, resaleController.listMine);
router.post('/', authenticate, resaleController.create);
router.delete('/:id', authenticate, resaleController.cancel);
router.post('/:id/buy', authenticate, sensitiveActionLimiter, resaleController.buy);

// ---- Public browsing ----
router.get('/', resaleController.listActive);
router.get('/:id', resaleController.getOne);

module.exports = router;
