const asyncHandler = require('../utils/asyncHandler');
const feeService = require('../services/feeService');
const uploadService = require('../services/uploadService');
const artistService = require('../services/artistService');
const AppError = require('../utils/AppError');

const listMine = asyncHandler(async (req, res) => {
  const charges = await feeService.listMyCharges(req.user.id, { status: req.query.status });
  res.json({ data: charges });
});

const getOne = asyncHandler(async (req, res) => {
  const charge = await feeService.getCharge(req.params.id, req.user.id);
  res.json({ data: charge });
});

// Lists the destinations (bank accounts / crypto wallets) available for
// a user to pay a fee into, in the charge's currency.
const listDestinations = asyncHandler(async (req, res) => {
  const charge = await feeService.getCharge(req.params.id, req.user.id);
  const all = await feeService.listPaymentDestinations();
  const filtered = all.filter((d) => !d.currency || d.currency === charge.currency);
  res.json({ data: filtered });
});

/**
 * Pays a fee charge. `method` selects the settlement path:
 *   - balance_deduction: deducted from the artist's own ledger balance immediately.
 *   - bank_transfer / crypto: attaches an admin destination; the user then
 *     uploads proof via POST /:id/proof, and an admin verifies it.
 *   - card: reuses the payment abstraction layer to charge a card directly.
 */
const pay = asyncHandler(async (req, res) => {
  const { method, destinationId } = req.body;
  if (!['balance_deduction', 'bank_transfer', 'crypto', 'card'].includes(method)) {
    throw new AppError('Invalid payment method.', 422, 'VALIDATION_ERROR');
  }

  if (method === 'balance_deduction') {
    const profile = await artistService.getProfileByUserId(req.user.id);
    if (!profile) throw new AppError('Balance payment is only available to artist accounts.', 400, 'NOT_ELIGIBLE');
    const charge = await feeService.settleByBalanceDeduction(req.params.id, req.user.id, profile.id);
    return res.json({ data: charge });
  }

  if (method === 'bank_transfer' || method === 'crypto') {
    if (!destinationId) throw new AppError('A payment destination is required for this method.', 422, 'VALIDATION_ERROR');
    const result = await feeService.selectManualDestination(req.params.id, req.user.id, method, destinationId);
    return res.json({ data: result.charge, destination: result.destination, message: 'Please complete the transfer and upload proof of payment.' });
  }

  if (method === 'card') {
    // Delegated to the same provider-agnostic payment abstraction used for
    // order checkout — see paymentService.js. Kept as a narrow, explicit
    // TODO here rather than silently no-op'ing, since wiring a real card
    // charge for a standalone fee (not tied to an order) is Phase 5 scope.
    throw new AppError('Card payment for fees is not yet available — please use balance, bank transfer, or crypto for now.', 501, 'NOT_IMPLEMENTED');
  }
});

const uploadProof = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('No proof file uploaded.', 400, 'FILE_REQUIRED');

  const result = await uploadService.uploadVerificationDocument(req.file, { userId: req.user.id, documentType: 'fee_payment_proof' });
  const charge = await feeService.attachProof(req.params.id, req.user.id, result.storagePath);
  res.json({ data: charge, message: 'Proof submitted. An admin will verify your payment shortly.' });
});

module.exports = { listMine, getOne, listDestinations, pay, uploadProof };
