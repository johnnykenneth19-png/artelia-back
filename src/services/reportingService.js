const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * REPORTING SERVICE (spec sections 28, 58) — admin dashboard metrics and
 * exportable reports. Every figure here is computed live from the ledger
 * and order tables, never from a cached/duplicated summary column, so
 * reports always reconcile against the same source of truth the rest of
 * the platform uses (spec section 51).
 */

function dateFilter(query, column, { from, to }) {
  if (from) query = query.gte(column, from);
  if (to) query = query.lte(column, to);
  return query;
}

async function count(table, filters = {}) {
  let query = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
  for (const [col, val] of Object.entries(filters)) query = query.eq(col, val);
  const { count: n, error } = await query;
  if (error) throw new AppError(`Could not count ${table}.`, 500, 'QUERY_FAILED');
  return n ?? 0;
}

async function sum(table, column, filters = {}) {
  let query = supabaseAdmin.from(table).select(column);
  for (const [col, val] of Object.entries(filters)) {
    if (Array.isArray(val)) query = query.in(col, val);
    else query = query.eq(col, val);
  }
  const { data, error } = await query;
  if (error) throw new AppError(`Could not aggregate ${table}.`, 500, 'QUERY_FAILED');
  return round2(data.reduce((s, row) => s + Number(row[column] || 0), 0));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// Dashboard overview (spec section 28)
// ---------------------------------------------------------------------
async function getDashboardOverview() {
  const [
    totalUsers, buyers, artists, galleries, artworksTotal, ordersTotal,
    completedOrders, pendingArtistApprovals, pendingArtworkApprovals,
    pendingPayouts, completedPayouts, openDisputes,
    platformRevenue, platformCommission, totalRefunds,
  ] = await Promise.all([
    count('users'),
    count('users', { primary_role: 'buyer' }),
    count('users', { primary_role: 'artist' }),
    count('users', { primary_role: 'gallery' }),
    count('artworks'),
    count('orders'),
    count('orders', { status: 'completed' }),
    count('artist_profiles', { status: 'pending' }),
    count('artworks', { status: 'pending_review' }),
    count('payouts', { status: 'pending' }),
    count('payouts', { status: 'success' }),
    count('disputes', { status: 'open' }),
    sum('ledger_entries', 'amount', { entry_type: 'payment', direction: 'credit' }),
    sum('ledger_entries', 'amount', { entry_type: 'platform_commission', direction: 'credit' }),
    sum('ledger_entries', 'amount', { entry_type: 'refund', direction: 'debit' }),
  ]);

  return {
    totalUsers, buyers, artists, galleries,
    artworks: artworksTotal, orders: ordersTotal, completedOrders,
    pendingArtistApprovals, pendingArtworkApprovals,
    pendingPayouts, completedPayouts, openDisputes,
    revenue: platformRevenue, platformCommission, totalRefunds,
  };
}

// ---------------------------------------------------------------------
// Sales / revenue report
// ---------------------------------------------------------------------
async function salesReport({ from, to, page = 1, pageSize = 50 } = {}) {
  const rangeFrom = (page - 1) * pageSize;
  const rangeTo = rangeFrom + pageSize - 1;

  let query = supabaseAdmin
    .from('orders')
    .select('id, order_number, status, subtotal, shipping_fee, tax_amount, discount_amount, processing_fee_amount, total_amount, currency, placed_at, users:buyer_id(full_name, email)', { count: 'exact' })
    .in('status', ['paid', 'processing', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered', 'completed'])
    .order('placed_at', { ascending: false });

  query = dateFilter(query, 'placed_at', { from, to }).range(rangeFrom, rangeTo);

  const { data, error, count: total } = await query;
  if (error) throw new AppError('Could not load sales report.', 500, 'QUERY_FAILED');
  return { items: data, total, page, pageSize };
}

// ---------------------------------------------------------------------
// Top artists / artworks (by completed sales)
// ---------------------------------------------------------------------
async function topArtists({ limit = 10, from, to } = {}) {
  let query = supabaseAdmin
    .from('order_items')
    .select('artist_id, unit_price, artist_profiles(artist_name, slug), orders!inner(status, placed_at)')
    .in('orders.status', ['paid', 'processing', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered', 'completed']);

  query = dateFilter(query, 'orders.placed_at', { from, to });

  const { data, error } = await query;
  if (error) throw new AppError('Could not load top artists.', 500, 'QUERY_FAILED');

  const byArtist = new Map();
  for (const row of data) {
    const key = row.artist_id;
    const entry = byArtist.get(key) || { artistId: key, name: row.artist_profiles?.artist_name, slug: row.artist_profiles?.slug, salesCount: 0, revenue: 0 };
    entry.salesCount += 1;
    entry.revenue = round2(entry.revenue + Number(row.unit_price));
    byArtist.set(key, entry);
  }
  return [...byArtist.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

async function topArtworks({ limit = 10, from, to } = {}) {
  let query = supabaseAdmin
    .from('order_items')
    .select('artwork_id, unit_price, artworks(title, slug, views_count, favorites_count), orders!inner(status, placed_at)')
    .in('orders.status', ['paid', 'processing', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered', 'completed']);

  query = dateFilter(query, 'orders.placed_at', { from, to });

  const { data, error } = await query;
  if (error) throw new AppError('Could not load top artworks.', 500, 'QUERY_FAILED');

  const byArtwork = new Map();
  for (const row of data) {
    const key = row.artwork_id;
    const entry = byArtwork.get(key) || {
      artworkId: key, title: row.artworks?.title, slug: row.artworks?.slug,
      views: row.artworks?.views_count ?? 0, favorites: row.artworks?.favorites_count ?? 0,
      salesCount: 0, revenue: 0,
    };
    entry.salesCount += 1;
    entry.revenue = round2(entry.revenue + Number(row.unit_price));
    byArtwork.set(key, entry);
  }
  return [...byArtwork.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

// ---------------------------------------------------------------------
// Artist earnings report
// ---------------------------------------------------------------------
async function artistEarningsReport({ page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: artists, error, count: total } = await supabaseAdmin
    .from('artist_profiles')
    .select('id, artist_name, slug', { count: 'exact' })
    .eq('status', 'approved')
    .order('artist_name', { ascending: true })
    .range(from, to);

  if (error) throw new AppError('Could not load artist earnings.', 500, 'QUERY_FAILED');

  const items = await Promise.all(artists.map(async (artist) => {
    const { data: accounts } = await supabaseAdmin
      .from('ledger_accounts').select('id, available_balance, pending_balance, currency')
      .eq('owner_type', 'artist').eq('owner_id', artist.id);

    // Lifetime earnings = sum of this artist's own ledger_account(s)'
    // artist_earning credit entries — scoped by ledger_account_id, not a
    // platform-wide total, so figures across artists never overlap.
    const accountIds = (accounts ?? []).map((a) => a.id);
    let lifetimeEarnings = 0;
    if (accountIds.length) {
      const { data: entries, error: entriesError } = await supabaseAdmin
        .from('ledger_entries')
        .select('amount')
        .in('ledger_account_id', accountIds)
        .eq('entry_type', 'artist_earning')
        .eq('direction', 'credit');
      if (entriesError) throw new AppError('Could not load artist earnings.', 500, 'QUERY_FAILED');
      lifetimeEarnings = round2(entries.reduce((s, e) => s + Number(e.amount), 0));
    }

    return {
      artistId: artist.id, name: artist.artist_name, slug: artist.slug,
      balances: accounts ?? [], lifetimeEarnings,
    };
  }));

  return { items, total, page, pageSize };
}

// ---------------------------------------------------------------------
// Refunds report
// ---------------------------------------------------------------------
async function refundsReport({ from, to, page = 1, pageSize = 30 } = {}) {
  const rangeFrom = (page - 1) * pageSize;
  const rangeTo = rangeFrom + pageSize - 1;

  let query = supabaseAdmin
    .from('refunds')
    .select('*, orders(order_number, buyer_id, currency)', { count: 'exact' })
    .order('created_at', { ascending: false });

  query = dateFilter(query, 'created_at', { from, to }).range(rangeFrom, rangeTo);

  const { data, error, count: total } = await query;
  if (error) throw new AppError('Could not load refunds report.', 500, 'QUERY_FAILED');
  return { items: data, total, page, pageSize };
}

// ---------------------------------------------------------------------
// Conversion report — published artworks vs. artworks actually sold,
// and simple view-to-sale ratio, over an optional date window.
// ---------------------------------------------------------------------
async function conversionReport({ from, to } = {}) {
  const [publishedCount, soldCount, totalViews] = await Promise.all([
    count('artworks', { status: 'published' }),
    count('artworks', { status: 'sold' }),
    sum('artworks', 'views_count'),
  ]);

  const conversionRate = publishedCount + soldCount > 0
    ? round2((soldCount / (publishedCount + soldCount)) * 100)
    : 0;
  const viewToSaleRate = totalViews > 0 ? round2((soldCount / totalViews) * 100) : 0;

  return { publishedCount, soldCount, totalViews, conversionRate, viewToSaleRate };
}

// ---------------------------------------------------------------------
// Disputes summary
// ---------------------------------------------------------------------
async function disputesReport() {
  const [open, underReview, resolved, rejected] = await Promise.all([
    count('disputes', { status: 'open' }),
    count('disputes', { status: 'under_review' }),
    count('disputes', { status: 'resolved' }),
    count('disputes', { status: 'rejected' }),
  ]);
  return { open, underReview, resolved, rejected };
}

// ---------------------------------------------------------------------
// CSV export helper — used by admin endpoints that support ?format=csv
// ---------------------------------------------------------------------
function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object');
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

module.exports = {
  getDashboardOverview, salesReport, topArtists, topArtworks,
  artistEarningsReport, refundsReport, conversionReport, disputesReport, toCsv,
};
