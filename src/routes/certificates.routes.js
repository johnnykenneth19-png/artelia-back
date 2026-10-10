const router = require('express').Router();
const certificateController = require('../controllers/certificateController');

// Fully public — this is the trust-building verification page the spec
// describes as /verify/:number. No authentication, no rate-limit beyond
// the global API limiter already applied in app.js.
router.get('/verify/:number', certificateController.verify);

module.exports = router;
