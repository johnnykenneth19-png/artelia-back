const router = require('express').Router();
const shipmentController = require('../controllers/shipmentController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');

router.use(authenticate);

router.get('/order/:orderId', shipmentController.getForOrder);
router.post('/order/:orderId/request-return', shipmentController.requestReturn);
router.patch('/:id', requireRole('artist'), shipmentController.updateStatus);

module.exports = router;
