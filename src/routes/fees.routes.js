const router = require('express').Router();
const feeController = require('../controllers/feeController');
const { authenticate } = require('../middleware/auth');
const { singleDocument } = require('../middleware/upload');
const { sensitiveActionLimiter } = require('../middleware/rateLimit');

router.use(authenticate);

router.get('/', feeController.listMine);
router.get('/:id', feeController.getOne);
router.get('/:id/destinations', feeController.listDestinations);
router.post('/:id/pay', sensitiveActionLimiter, feeController.pay);
router.post('/:id/proof', sensitiveActionLimiter, singleDocument, feeController.uploadProof);

module.exports = router;
