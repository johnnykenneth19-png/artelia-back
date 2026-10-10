const crypto = require('crypto');
const config = require('../config');
const AppError = require('../utils/AppError');

/**
 * PAYOUT PROVIDER ABSTRACTION — mirrors paymentService's shape so a new
 * provider (Flutterwave, Wise, a manual-only mode, etc.) can be added
 * without touching payoutService's orchestration logic. Each adapter
 * implements:
 *   ensureRecipient(payoutAccount) -> { recipientCode }
 *   sendTransfer(recipientCode, amount, currency, reference, reason) -> { providerReference, status }
 *   verifyWebhookSignature(rawBody, signatureHeader) -> boolean
 *   parseWebhookEvent(rawBody) -> { providerReference, status: 'success'|'failed'|'reversed'|'ignored' }
 */

async function providerFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.message || `Payout provider request failed (${res.status}).`;
    throw new AppError(message, 502, 'PAYOUT_PROVIDER_ERROR');
  }
  return json;
}

function toSubunit(amount) {
  return Math.round(Number(amount) * 100);
}

const providers = {
  paystack: {
    async ensureRecipient(payoutAccount) {
      if (payoutAccount.provider_recipient_code) return { recipientCode: payoutAccount.provider_recipient_code };

      if (!payoutAccount.bank_code || !payoutAccount.account_number_encrypted || !payoutAccount.account_name) {
        throw new AppError('This artist\'s payout bank details are incomplete — bank code, account number, and account name are required.', 400, 'PAYOUT_ACCOUNT_INCOMPLETE');
      }

      const json = await providerFetch('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.payment.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'nuban',
          name: payoutAccount.account_name,
          account_number: payoutAccount.account_number_encrypted, // see schema note: production should decrypt via KMS here
          bank_code: payoutAccount.bank_code,
          currency: payoutAccount.currency || 'NGN',
        }),
      });

      if (!json.status) throw new AppError(json.message || 'Could not register payout recipient.', 502, 'PAYOUT_PROVIDER_ERROR');
      return { recipientCode: json.data.recipient_code };
    },

    async sendTransfer(recipientCode, amount, currency, reference, reason) {
      const json = await providerFetch('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.payment.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'balance',
          amount: toSubunit(amount),
          recipient: recipientCode,
          reference,
          reason,
        }),
      });

      if (!json.status) throw new AppError(json.message || 'Could not initiate transfer.', 502, 'PAYOUT_PROVIDER_ERROR');

      // Paystack returns 'success' (rare, instant), 'pending', or 'otp'
      // (requires dashboard OTP approval for certain account configurations).
      // Either way, we treat the transfer as "in flight" until a webhook
      // or admin confirmation finalizes it — see payoutService.markProcessed.
      const status = json.data.status === 'success' ? 'success' : 'pending';
      return { providerReference: json.data.reference || reference, status, raw: json.data };
    },

    // Same signing scheme as the payment webhook: Paystack signs with the
    // integration secret key itself.
    verifyWebhookSignature(rawBody, signatureHeader) {
      if (!signatureHeader) return false;
      const hash = crypto.createHmac('sha512', config.payment.secretKey).update(rawBody).digest('hex');
      const bufA = Buffer.from(hash, 'hex');
      const bufB = Buffer.from(signatureHeader, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    },

    parseWebhookEvent(rawBody) {
      const payload = JSON.parse(rawBody);
      let status = 'ignored';
      if (payload.event === 'transfer.success') status = 'success';
      else if (payload.event === 'transfer.failed') status = 'failed';
      else if (payload.event === 'transfer.reversed') status = 'reversed';

      return { providerReference: payload.data?.reference, status, raw: payload };
    },
  },
};

function getPayoutProvider(name = config.payment.provider) {
  const provider = providers[name];
  if (!provider) throw new AppError('Payout provider not configured for this payment provider.', 500, 'PAYOUT_PROVIDER_NOT_CONFIGURED');
  return provider;
}

module.exports = { getPayoutProvider };
