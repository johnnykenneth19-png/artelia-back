const asyncHandler = require('../utils/asyncHandler');
const shipmentService = require('../services/shipmentService');
const artistService = require('../services/artistService');
const AppError = require('../utils/AppError');

const getForOrder = asyncHandler(async (req, res) => {
  // Ownership of the order itself is checked by orderController's own
  // route (buyers view this nested in GET /orders/:id); this endpoint
  // additionally allows a contributing artist to look it up directly.
  const shipment = await shipmentService.getForOrder(req.params.orderId);
  if (!shipment) throw new AppError('No shipment found for this order yet.', 404, 'NOT_FOUND');
  res.json({ data: shipment });
});

const updateStatus = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const { status, courier, trackingNumber, description } = req.body;
  if (!status) throw new AppError('A status is required.', 422, 'VALIDATION_ERROR');

  const shipment = await shipmentService.updateStatus(req.params.id, profile.id, { status, courier, trackingNumber, description });
  res.json({ data: shipment });
});

const requestReturn = asyncHandler(async (req, res) => {
  const shipment = await shipmentService.requestReturn(req.params.orderId, req.user.id, req.body.reason);
  res.json({ data: shipment });
});

module.exports = { getForOrder, updateStatus, requestReturn };
