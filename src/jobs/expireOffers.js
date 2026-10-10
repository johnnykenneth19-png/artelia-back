#!/usr/bin/env node
/**
 * Runnable entry point that expires offers past their expires_at while
 * still pending (spec sections 18, 52). Recommended: hourly.
 *   cd /app && node src/jobs/expireOffers.js >> /var/log/artelia-expire-offers.log 2>&1
 */
const offerService = require('../services/offerService');

async function main() {
  console.log(`[expire-offers] starting at ${new Date().toISOString()}`);
  const count = await offerService.expireStale();
  console.log(`[expire-offers] expired: ${count}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[expire-offers] job failed:', err);
    process.exit(1);
  });
