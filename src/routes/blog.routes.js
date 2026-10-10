const router = require('express').Router();
const blogController = require('../controllers/blogController');

router.get('/', blogController.list);
router.get('/:slug', blogController.getOne);

module.exports = router;
