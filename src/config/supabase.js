const { createClient } = require('@supabase/supabase-js');
const config = require('./index');

// Service-role client: full DB access, bypasses RLS. Used ONLY inside
// backend services after our own auth/authorization checks have run.
// NEVER import this into anything that could echo it back to a client.
const supabaseAdmin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Anon client: respects RLS. Reserved for any read path we deliberately
// want scoped by the database's own policies rather than app logic.
const supabaseAnon = createClient(config.supabase.url, config.supabase.anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAdmin, supabaseAnon };
