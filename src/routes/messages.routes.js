const router = require('express').Router();
const messageController = require('../controllers/messageController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/conversations', messageController.listConversations);
router.get('/thread/:userId', messageController.getThread);
router.post('/', messageController.send);
router.post('/:id/report', messageController.report);
router.get('/blocked', messageController.listBlocked);
router.post('/block/:userId', messageController.blockUser);
router.delete('/block/:userId', messageController.unblockUser);

module.exports = router;
