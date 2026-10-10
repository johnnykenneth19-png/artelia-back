const router = require('express').Router();
const collectionController = require('../controllers/collectionController');

router.get('/', collectionController.list);
router.get('/:slug', collectionController.getOne);

module.exports = router;
