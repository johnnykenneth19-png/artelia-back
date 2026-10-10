const router = require('express').Router();
const offerController = require('../controllers/offerController');
const { authenticate } = require('../middleware/auth');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

router.use(authenticate);

router.post('/', sensitiveActionLimiter, offerController.create);
router.get('/mine', offerController.listMine);
router.get('/received', offerController.listReceived);
router.get('/:id', offerController.getOne);
router.post('/:id/accept', sensitiveActionLimiter, offerController.accept);
router.post('/:id/reject', offerController.reject);
router.post('/:id/counter', sensitiveActionLimiter, offerController.counter);
router.post('/:id/cancel', offerController.cancel);
router.get('/:id/messages', offerController.getThread);
router.post('/:id/messages', offerController.addMessage);

module.exports = router;
