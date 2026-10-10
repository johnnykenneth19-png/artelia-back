const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * GALLERY ACCOUNTS (spec section 39). A gallery is approved the same
 * way an artist is (spec section 29's pattern, reused rather than
 * duplicated — `gallery_profiles.status` uses the same `artist_status`
 * enum). Staff permissions are controlled via `gallery_members.role`
 * ('owner' | 'manager' | 'staff'); an artist joins a gallery's roster by
 * their OWN action (artist_profiles.gallery_id), never by the gallery
 * unilaterally claiming them — mirrors the platform's existing rule
 * that ownership/attribution changes must come from the party who owns
 * the thing being changed.
 */

const MANAGE_ROLES = ['owner', 'manager'];

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function assertManages(galleryId, userId) {
  const { data: member, error } = await supabaseAdmin
    .from('gallery_members').select('role').eq('gallery_id', galleryId).eq('user_id', userId).maybeSingle();
  if (error || !member || !MANAGE_ROLES.includes(member.role)) {
    throw new AppError('You do not have permission to manage this gallery.', 403, 'FORBIDDEN');
  }
  return member;
}

// ---------------------------------------------------------------------
// Onboarding (mirrors spec section 9's artist flow)
// ---------------------------------------------------------------------

async function apply(userId, { galleryName, description, location, country }) {
  if (!galleryName || galleryName.trim().length < 2) throw new AppError('A gallery name is required.', 422, 'VALIDATION_ERROR');

  const { data: existing } = await supabaseAdmin.from('gallery_members').select('gallery_id').eq('user_id', userId).eq('role', 'owner').maybeSingle();
  if (existing) throw new AppError('You already own a gallery account.', 409, 'ALREADY_EXISTS');

  const { data: gallery, error } = await supabaseAdmin
    .from('gallery_profiles')
    .insert({ owner_user_id: userId, gallery_name: galleryName, slug: slugify(galleryName), description, location, country, status: 'pending' })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('A gallery with a similar name already exists.', 409, 'DUPLICATE_SLUG');
    throw new AppError('Could not submit gallery application.', 500, 'CREATE_FAILED');
  }

  await supabaseAdmin.from('gallery_members').insert({ gallery_id: gallery.id, user_id: userId, role: 'owner' });
  await supabaseAdmin.from('user_roles').upsert({ user_id: userId, role: 'gallery' }, { onConflict: 'user_id,role' });

  return gallery;
}

async function getMine(userId) {
  const { data: membership, error: memberError } = await supabaseAdmin
    .from('gallery_members').select('gallery_id, role').eq('user_id', userId).maybeSingle();
  if (memberError || !membership) throw new AppError('You are not part of a gallery.', 404, 'NOT_FOUND');

  const { data: gallery, error } = await supabaseAdmin.from('gallery_profiles').select('*').eq('id', membership.gallery_id).single();
  if (error || !gallery) throw new AppError('Gallery not found.', 404, 'NOT_FOUND');
  return { ...gallery, myRole: membership.role };
}

/** Public directory of approved galleries (spec section 39's gallery browsing). */
async function listApproved({ page = 1, pageSize = 24 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('gallery_profiles')
    .select('id, gallery_name, slug, location, country, logo_url, cover_image_url', { count: 'exact' })
    .eq('status', 'approved')
    .order('gallery_name', { ascending: true })
    .range(from, to);

  if (error) throw new AppError('Could not load galleries.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getPublicBySlug(slug) {
  const { data, error } = await supabaseAdmin.from('gallery_profiles').select('*').eq('slug', slug).eq('status', 'approved').maybeSingle();
  if (error) throw new AppError('Could not load gallery.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Gallery not found.', 404, 'NOT_FOUND');
  return data;
}

async function updateProfile(galleryId, userId, updates) {
  await assertManages(galleryId, userId);
  const patch = {};
  for (const [key, col] of [
    ['description', 'description'], ['location', 'location'], ['country', 'country'],
    ['logoUrl', 'logo_url'], ['coverImageUrl', 'cover_image_url'],
  ]) {
    if (updates[key] !== undefined) patch[col] = updates[key];
  }
  const { data, error } = await supabaseAdmin.from('gallery_profiles').update(patch).eq('id', galleryId).select('*').single();
  if (error) throw new AppError('Could not update gallery.', 500, 'UPDATE_FAILED');
  return data;
}

// ---------------------------------------------------------------------
// Staff management (spec section 39: "Allow gallery staff to have
// controlled permissions")
// ---------------------------------------------------------------------

async function listMembers(galleryId, userId) {
  await assertManages(galleryId, userId);
  const { data, error } = await supabaseAdmin
    .from('gallery_members').select('id, role, created_at, users:user_id(id, full_name, email)').eq('gallery_id', galleryId).order('created_at', { ascending: true });
  if (error) throw new AppError('Could not load gallery staff.', 500, 'QUERY_FAILED');
  return data;
}

async function inviteMember(galleryId, requesterUserId, { email, role = 'staff' }) {
  await assertManages(galleryId, requesterUserId);
  if (!['manager', 'staff'].includes(role)) {
    throw new AppError('Staff role must be "manager" or "staff" (ownership cannot be granted this way).', 422, 'VALIDATION_ERROR');
  }

  const { data: user, error: userError } = await supabaseAdmin.from('users').select('id').eq('email', email).maybeSingle();
  if (userError || !user) throw new AppError('No account found with that email.', 404, 'USER_NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('gallery_members')
    .insert({ gallery_id: galleryId, user_id: user.id, role })
    .select('*, users:user_id(full_name, email)')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('This person is already on the gallery staff.', 409, 'ALREADY_MEMBER');
    throw new AppError('Could not add staff member.', 500, 'INSERT_FAILED');
  }
  return data;
}

async function updateMemberRole(galleryId, requesterUserId, memberId, role) {
  await assertManages(galleryId, requesterUserId);
  if (!['manager', 'staff'].includes(role)) {
    throw new AppError('Staff role must be "manager" or "staff".', 422, 'VALIDATION_ERROR');
  }
  const { data, error } = await supabaseAdmin
    .from('gallery_members')
    .update({ role })
    .eq('id', memberId)
    .eq('gallery_id', galleryId)
    .neq('role', 'owner') // the owner's role can never be changed through this path
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update staff role.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Could not find that staff member, or they are the gallery owner.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function removeMember(galleryId, requesterUserId, memberId) {
  await assertManages(galleryId, requesterUserId);
  const { data, error } = await supabaseAdmin
    .from('gallery_members')
    .delete()
    .eq('id', memberId)
    .eq('gallery_id', galleryId)
    .neq('role', 'owner')
    .select('id')
    .maybeSingle();

  if (error) throw new AppError('Could not remove staff member.', 500, 'DELETE_FAILED');
  if (!data) throw new AppError('Could not find that staff member, or they are the gallery owner.', 400, 'INVALID_STATE_TRANSITION');
}

// ---------------------------------------------------------------------
// Artist roster — an artist joins/leaves of their OWN accord (see
// module header). galleryService only reads the roster.
// ---------------------------------------------------------------------

async function joinAsArtist(artistUserId, galleryId) {
  const { data: gallery } = await supabaseAdmin.from('gallery_profiles').select('status').eq('id', galleryId).maybeSingle();
  if (!gallery || gallery.status !== 'approved') throw new AppError('This gallery is not currently accepting artists.', 400, 'GALLERY_NOT_APPROVED');

  const { data, error } = await supabaseAdmin
    .from('artist_profiles').update({ gallery_id: galleryId }).eq('user_id', artistUserId).select('*').maybeSingle();
  if (error) throw new AppError('Could not join gallery.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Artist profile not found.', 404, 'NOT_FOUND');
  return data;
}

async function leaveGallery(artistUserId) {
  const { data, error } = await supabaseAdmin
    .from('artist_profiles').update({ gallery_id: null }).eq('user_id', artistUserId).select('*').maybeSingle();
  if (error) throw new AppError('Could not leave gallery.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Artist profile not found.', 404, 'NOT_FOUND');
  return data;
}

async function listArtists(galleryId) {
  const { data, error } = await supabaseAdmin
    .from('artist_profiles').select('id, artist_name, slug, profile_image_url, is_verified, followers_count').eq('gallery_id', galleryId).order('artist_name', { ascending: true });
  if (error) throw new AppError('Could not load gallery artists.', 500, 'QUERY_FAILED');
  return data;
}

// ---------------------------------------------------------------------
// Inventory, sales & analytics (spec section 39)
// ---------------------------------------------------------------------

async function listInventory(galleryId, userId, { page = 1, pageSize = 24 } = {}) {
  await assertManages(galleryId, userId);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('artworks')
    .select('id, title, slug, price, currency, status, artist_profiles(artist_name)', { count: 'exact' })
    .eq('gallery_id', galleryId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load gallery inventory.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getAnalytics(galleryId, userId) {
  await assertManages(galleryId, userId);

  const { data: items, error } = await supabaseAdmin
    .from('order_items')
    .select('unit_price, currency, artworks!inner(gallery_id), orders!inner(status, placed_at)')
    .eq('artworks.gallery_id', galleryId)
    .in('orders.status', ['paid', 'processing', 'ready_for_shipment', 'shipped', 'in_transit', 'delivered', 'completed']);

  if (error) throw new AppError('Could not load gallery analytics.', 500, 'QUERY_FAILED');

  const salesCount = items.length;
  const revenue = Math.round(items.reduce((sum, i) => sum + Number(i.unit_price), 0) * 100) / 100;
  const [artworksTotal, artworksPublished] = await Promise.all([
    supabaseAdmin.from('artworks').select('id', { count: 'exact', head: true }).eq('gallery_id', galleryId),
    supabaseAdmin.from('artworks').select('id', { count: 'exact', head: true }).eq('gallery_id', galleryId).eq('status', 'published'),
  ]);

  return {
    salesCount, revenue,
    artworksTotal: artworksTotal.count ?? 0,
    artworksPublished: artworksPublished.count ?? 0,
  };
}

// ---------------------------------------------------------------------
// Admin moderation (mirrors spec section 29's artist approval exactly)
// ---------------------------------------------------------------------

async function listPending() {
  const { data, error } = await supabaseAdmin
    .from('gallery_profiles')
    .select('id, gallery_name, slug, location, country, status, created_at, users:owner_user_id(email, full_name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw new AppError('Could not load pending galleries.', 500, 'QUERY_FAILED');
  return data;
}

async function approve(galleryId) {
  const { data, error } = await supabaseAdmin
    .from('gallery_profiles').update({ status: 'approved' }).eq('id', galleryId).eq('status', 'pending').select('*').maybeSingle();
  if (error) throw new AppError('Could not approve gallery.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only pending galleries can be approved.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function reject(galleryId, reason) {
  const { data, error } = await supabaseAdmin
    .from('gallery_profiles').update({ status: 'rejected' }).eq('id', galleryId).eq('status', 'pending').select('*').maybeSingle();
  if (error) throw new AppError('Could not reject gallery.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only pending galleries can be rejected.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

async function suspend(galleryId) {
  const { data, error } = await supabaseAdmin
    .from('gallery_profiles').update({ status: 'suspended' }).eq('id', galleryId).eq('status', 'approved').select('*').maybeSingle();
  if (error) throw new AppError('Could not suspend gallery.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Only approved galleries can be suspended.', 400, 'INVALID_STATE_TRANSITION');
  return data;
}

module.exports = {
  apply, getMine, listApproved, getPublicBySlug, updateProfile,
  listMembers, inviteMember, updateMemberRole, removeMember,
  joinAsArtist, leaveGallery, listArtists,
  listInventory, getAnalytics,
  listPending, approve, reject, suspend,
};
