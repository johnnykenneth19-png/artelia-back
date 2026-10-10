const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const taxonomyService = require('../services/taxonomyService');

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await taxonomyService.listAll();
    res.json({ data });
  })
);

module.exports = router;
