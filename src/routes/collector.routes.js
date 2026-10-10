const router = require('express').Router();
const collectorController = require('../controllers/collectorController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate); // everything here is strictly the authenticated user's own private data (spec section 38)

router.post('/activate', collectorController.becomeCollector);
router.get('/collection', collectorController.getMyCollection);
router.get('/notes', collectorController.listNotes);
router.put('/notes/:artworkId', collectorController.upsertNote);
router.delete('/notes/:artworkId', collectorController.removeNote);

module.exports = router;
