const router = require('express').Router();

router.use('/auth', require('./auth.routes'));
router.use('/artworks', require('./artworks.routes'));
router.use('/artists', require('./artists.routes'));
router.use('/taxonomy', require('./taxonomy.routes'));
router.use('/fees', require('./fees.routes'));
router.use('/payouts', require('./payouts.routes'));
router.use('/wishlists', require('./wishlists.routes'));
router.use('/cart', require('./cart.routes'));
router.use('/orders', require('./orders.routes'));
router.use('/offers', require('./offers.routes'));
router.use('/commissions', require('./commissions.routes'));
router.use('/messages', require('./messages.routes'));
router.use('/notifications', require('./notifications.routes'));
router.use('/certificates', require('./certificates.routes'));
router.use('/shipments', require('./shipments.routes'));
router.use('/disputes', require('./disputes.routes'));
router.use('/reviews', require('./reviews.routes'));
router.use('/collections', require('./collections.routes'));
router.use('/exhibitions', require('./exhibitions.routes'));
router.use('/blog', require('./blog.routes'));
router.use('/marketing', require('./marketing.routes'));
router.use('/admin', require('./admin.routes'));

// ---- Phase 9 ----
router.use('/resale', require('./resale.routes'));
router.use('/collector', require('./collector.routes'));
router.use('/galleries', require('./galleries.routes'));
router.use('/room-view', require('./room-view.routes'));

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'artelia-api' }));

module.exports = router;
