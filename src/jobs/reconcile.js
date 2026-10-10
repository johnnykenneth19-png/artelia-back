#!/usr/bin/env node
/**
 * Runnable entry point for the payment reconciliation sweep (spec
 * section 51/52). Not invoked automatically by this codebase — schedule
 * it externally, e.g. a cron entry that runs every 5 minutes:
 *   cd /app && node src/jobs/reconcile.js >> /var/log/artelia-reconcile.log 2>&1
 * or as a scheduled task on Render/Railway/a Supabase Edge Function cron.
 *
 * Exits 0 on a completed run (even if it flagged issues — flags are for
 * a human, not a job failure) and non-zero only if the sweep itself
 * couldn't run (e.g. database unreachable).
 */
const reconciliationService = require('../services/reconciliationService');

async function main() {
  console.log(`[reconcile] starting sweep at ${new Date().toISOString()}`);

  const pendingSummary = await reconciliationService.reconcilePendingPayments();
  console.log('[reconcile] pending payments:', pendingSummary);

  const finalizedSummary = await reconciliationService.reconcileFinalizedOrders();
  console.log('[reconcile] finalized-order check:', finalizedSummary);

  console.log(`[reconcile] done at ${new Date().toISOString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[reconcile] sweep failed:', err);
    process.exit(1);
  });
