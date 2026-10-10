const router = require('express').Router();
const exhibitionController = require('../controllers/exhibitionController');

router.get('/', exhibitionController.list);
router.get('/:slug', exhibitionController.getOne);

module.exports = router;
