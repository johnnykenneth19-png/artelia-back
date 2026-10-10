const asyncHandler = require('../utils/asyncHandler');
const disputeService = require('../services/disputeService');
const uploadService = require('../services/uploadService');
const AppError = require('../utils/AppError');

const create = asyncHandler(async (req, res) => {
  const { orderId, reason, description } = req.body;
  if (!orderId || !reason) throw new AppError('orderId and reason are required.', 422, 'VALIDATION_ERROR');

  let evidenceUrls = [];
  if (req.files?.length) {
    for (const file of req.files) {
      const result = await uploadService.uploadVerificationDocument(file, { userId: req.user.id, documentType: 'dispute_evidence' });
      evidenceUrls.push(result.storagePath);
    }
  }

  const dispute = await disputeService.create(req.user.id, orderId, { reason, description, evidenceUrls });
  res.status(201).json({ data: dispute });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await disputeService.listMine(req.user.id);
  res.json({ data });
});

const getOne = asyncHandler(async (req, res) => {
  const data = await disputeService.getMine(req.params.id, req.user.id);
  res.json({ data });
});

module.exports = { create, listMine, getOne };
