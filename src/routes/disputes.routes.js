const router = require('express').Router();
const disputeController = require('../controllers/disputeController');
const { authenticate } = require('../middleware/auth');
const { multipleImages } = require('../middleware/upload');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

router.use(authenticate);

router.post('/', sensitiveActionLimiter, multipleImages, disputeController.create);
router.get('/mine', disputeController.listMine);
router.get('/:id', disputeController.getOne);

module.exports = router;
