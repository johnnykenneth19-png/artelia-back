#!/usr/bin/env node
/**
 * Runnable entry point that releases expired checkout holds (spec
 * section 49/52) — both the artwork-level reservation and the parent
 * order's status. Intended to run frequently (every 1-5 minutes is
 * reasonable given the 20-minute reservation hold configured in
 * src/config/index.js):
 *   cd /app && node src/jobs/releaseExpired.js >> /var/log/artelia-release.log 2>&1
 */
const { supabaseAdmin } = require('../config/supabase');
const orderService = require('../services/orderService');

async function main() {
  console.log(`[release-expired] starting at ${new Date().toISOString()}`);

  const { data: releasedCount, error } = await supabaseAdmin.rpc('release_expired_reservations');
  if (error) throw error;
  console.log(`[release-expired] artworks released: ${releasedCount}`);

  const ordersCancelled = await orderService.releaseExpiredOrders();
  console.log(`[release-expired] orders cancelled: ${ordersCancelled}`);

  console.log(`[release-expired] done at ${new Date().toISOString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[release-expired] job failed:', err);
    process.exit(1);
  });
