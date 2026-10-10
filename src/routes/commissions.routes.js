const router = require('express').Router();
const commissionController = require('../controllers/commissionController');
const { authenticate } = require('../middleware/auth');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

router.use(authenticate);

router.post('/', sensitiveActionLimiter, commissionController.create);
router.get('/mine', commissionController.listMine);
router.get('/received', commissionController.listReceived);
router.get('/:id', commissionController.getOne);
router.post('/:id/propose', commissionController.propose);
router.post('/:id/accept', commissionController.accept);
router.post('/:id/reject', commissionController.reject);
router.post('/:id/in-progress', commissionController.markInProgress);
router.post('/:id/delivered', commissionController.markDelivered);
router.post('/:id/completed', commissionController.markCompleted);
router.post('/:id/request-changes', commissionController.requestChanges);
router.get('/:id/messages', commissionController.getThread);
router.post('/:id/messages', commissionController.addMessage);

module.exports = router;
