# ARTELIA — Premium Online Art Marketplace

This is the foundation of ARTELIA: a Node.js/Express + Supabase (PostgreSQL)
backend and a premium, gallery-style frontend. It is built so every later
phase (payments, offers, commissions, admin, etc.) plugs into what's here
without rearchitecting.

## What's implemented in this pass (Phase 1–4, plus a full Fee Management system)

**Database** (`database/schema.sql`, `rls_policies.sql`, `functions.sql`, `fees_schema.sql`, `seed_fee_types.sql`)
- Full normalized schema: users, roles, artist/buyer/gallery profiles,
  artworks + images + editions + certificates, provenance, orders,
  payments, refunds, shipments, **immutable financial ledger**, offers,
  commissions, messages, reviews, disputes, notifications, admin/audit,
  blog, settings — every table from the spec's section 46 list.
- Row Level Security policies enforcing tenant isolation at the DB layer.
- `NUMERIC(14,2)` everywhere money is stored — no floats.
- **`fees_schema.sql` (new)**: `fee_types`, `fee_rules`, `fee_charges`,
  `admin_payment_destinations` — the full configurable fee system (see
  below). `seed_fee_types.sql` registers the built-in fee gateways with
  zero active rules, so nothing is charged anywhere until an admin
  deliberately configures one.

**Backend** (`src/`)
- Everything from Phases 1–3 (auth, RBAC, artwork lifecycle, uploads,
  artist onboarding, admin moderation) — see prior notes below.
- **`feeService.js` (new) — the fee management engine.** Every
  fee-charging action goes through `resolveApplicableFee()` /
  `getOrCreateCharge()` rather than a hard-coded amount:
  - Admin defines a `fee_type` (e.g. `artwork_upload`, `withdrawal`,
    `order_payment_processing`) and any number of `fee_rules` against it
    — global, artist-specific, category-specific, or promotional, each
    fixed or percentage-based, with optional min/max and a start/end
    window. Priority resolution mirrors the existing commission-rule
    logic (artist > category > promotion > global).
  - A resolved fee becomes an immutable `fee_charge` row. Settlement
    supports four methods, matching the request exactly:
    - **balance_deduction** — immediate, for artists with a ledger balance.
    - **bank_transfer** — attaches an admin-published bank account
      (`admin_payment_destinations`); payer uploads proof; admin verifies.
    - **crypto** — same manual flow, against an admin-published wallet.
    - **card** — stubbed to the existing payment abstraction layer (full
      standalone-fee card charging is a short Phase 5 follow-up; order
      checkout's processing fee already works today since it's folded
      into the normal order payment).
  - Every settlement — automatic or admin-verified — posts through
    `ledgerService` as a `'fee'` ledger entry, so fee revenue is exactly
    as auditable as any other financial movement (spec section 26).
  - Admin CRUD for fee types, fee rules, and payment destinations; a
    verification queue for manual bank/crypto proofs; a waive path for
    goodwill exemptions. Every admin action here is written to
    `admin_actions` + `audit_logs`.
  - **Gateways wired up in this pass:**
    - `artworkService.submitForReview` → `'artwork_upload'` fee. If
      active, submission is blocked with a 402 `FEE_PAYMENT_REQUIRED`
      (carrying the charge) until it's settled.
    - `payoutService.requestPayout` → `'withdrawal'` fee. Deducted
      automatically from the requested amount via balance settlement;
      the payout row always reflects the true net.
    - `orderService.createFromCart` → `'order_payment_processing'` fee.
      Added as its own line (`orders.processing_fee_amount`) to the
      order total, so it's paid as part of the normal checkout payment
      rather than a separate settlement step.
  - Adding a new chargeable action anywhere else in the app is a single
    `feeService.getOrCreateCharge({ feeTypeCode: 'new_code', ... })` call
    plus a new `fee_types` row — no new calculation logic required.
- **`payoutService.js` (new, pulled forward from Phase 5)** — withdrawal
  request → fee gateway → ledger debit → pending payout, with admin
  `markProcessed`/`markFailed` (the latter reverses the ledger debit).
- **`wishlistService.js` / `cartService.js` / `orderService.js` (new,
  Phase 4)**:
  - Wishlists support multiple named collections and public sharing via
    an unguessable token (spec section 13).
  - The cart **never stores a price** — every read joins live against
    `artworks` (spec section 15).
  - Checkout (`orderService.createFromCart`) is the piece that has to be
    airtight: it re-validates every item's availability, atomically
    reserves each unique artwork via the same conditional-`UPDATE`
    mechanism from Phase 1 (rolling back cleanly if any single item
    fails), snapshots price + commission rate at the moment of sale, and
    only then hands off to `paymentService.initiatePayment`. Buyer-side
    and background-job cancellation both release every reservation.

**Frontend** (`public/`)
- `public/cart.html` — cart + shipping address + checkout, calling the
  real API; no price math happens in the browser.
- `public/dashboard/fees.html` — artist-facing fee/withdrawal center:
  pay a pending fee (balance, bank transfer, or crypto with proof
  upload) and request withdrawals, with the fee shown transparently.
- `public/admin/` (new) — a lightweight admin console:
  - `fees.html` — create fee types, add/toggle rules per scope, all live.
  - `payment-destinations.html` — manage the bank accounts / crypto
    wallets admin publishes for manual fee payment.
  - `fee-charges.html` — verification queue for manual bank/crypto proofs.
  - `moderation.html` — the artwork/artist approval loop from Phase 3,
    now with an actual UI instead of curl commands.
- Homepage artwork cards now have a working **Add to Cart** button.

## Phase 5 additions — real payments, reconciliation, real payouts

**Payments** (`src/services/paymentService.js`)
- Two real, working provider adapters (proof the abstraction actually
  holds, not just a promise it would): **Paystack** (`transaction/initialize`,
  `transaction/verify`, `x-paystack-signature` webhook verification using
  the integration secret key) and **Stripe** (`checkout/sessions`,
  session retrieval, `stripe-signature` timestamped HMAC verification).
  Switch via `PAYMENT_PROVIDER` in `.env` — nothing else in the codebase
  changes.
- `POST /api/orders/:id/verify-payment` — called when the buyer lands
  back on `order-status.html` after the provider's checkout page. It
  never trusts redirect query params; it asks the provider directly via
  `verifyTransaction()`, using the exact same idempotent finalize path a
  webhook would. The webhook remains the primary confirmation route —
  this closes the gap between "buyer returned" and "webhook arrived."
- `finalizeFromEvent()` is now a single shared function used by the
  webhook handler, manual verification, *and* reconciliation — one code
  path that marks artwork sold, posts ledger entries, and issues
  certificates, guarded by the same duplicate-event check everywhere.

**Reconciliation** (`src/services/reconciliationService.js`, `database/reconciliation_schema.sql`)
- `reconcilePendingPayments()` — sweeps payments stuck in
  pending/processing past a grace period, asks the provider what
  actually happened, and finalizes them the same safe way a webhook
  would. Flags an `amount_mismatch` if the provider's reported amount
  disagrees with our own record — never silently trusts either side.
- `reconcileFinalizedOrders()` — sweeps payments already marked
  `success` and checks the order actually reached a finalized state,
  catching the case where a webhook landed but a later step
  (artwork-marking, ledger-posting) failed partway.
- Every mismatch becomes a `reconciliation_flags` row — spec section 51
  is explicit that mismatches get flagged for a human, never
  auto-"fixed." Admin resolves or dismisses each one from
  `/admin/reconciliation.html`, with notes recorded.

**Payouts — real transfers** (`src/services/payoutProviderService.js`, extended `payoutService.js`)
- `initiateProviderTransfer()` resolves (or registers) a Paystack
  transfer recipient from the artist's saved bank details, sends the
  actual transfer, and moves the payout to `processing` with the
  provider's reference attached.
- `POST /api/webhooks/payouts` confirms or reverses the transfer based
  on the provider's webhook (`transfer.success`/`transfer.failed`/
  `transfer.reversed`) — mirroring how payment webhooks are the source
  of truth for order payments. `markProcessed`/`markFailed` remain as a
  manual fallback for providers or flows not fully automated.
- Artists set their payout bank account (bank code, account number,
  account name) at `PUT /api/artists/me/payout-account` /
  `/dashboard/fees.html` — masked on every read, and any change
  invalidates the cached provider recipient so it's re-registered.

**Background jobs** (`src/jobs/`) — runnable entry points for the
schedulers spec section 52 asks for; nothing in this codebase invokes
them automatically:
- `reconcile.js` — runs both reconciliation sweeps (recommended: every 5 min).
- `releaseExpired.js` — releases expired artwork reservations *and*
  cancels the parent orders (recommended: every 1-5 min).
- `expireOffers.js` — expires pending offers past their 7-day window
  (recommended: hourly).

## Phase 6 additions — offers, commissions, messaging, notifications

**Offers / negotiation** (`src/services/offerService.js`, spec section 18)
- Each round of negotiation is its own `offers` row chained via
  `parent_offer_id`, so the full back-and-forth is a readable history,
  not an overwritten single row. A new `awaiting_response_from` column
  says whose turn it is — every transition keeps it accurate.
- Accepting — by either side — immediately calls the new
  `orderService.createFromOffer()`: the artwork is reserved and a real
  order created **at the negotiated price**, not the listed price, the
  instant acceptance happens. That's the "controlled checkout flow" the
  spec asks for. If the artwork turns out to be unavailable at that exact
  moment (a rare race), the offer rolls back to pending rather than
  claiming a phantom acceptance.
- FEE GATEWAY: `'offer_submission'` — charged once per initial offer
  (not on every counter-round), via the same `feeService` pattern as
  artwork uploads.
- `src/jobs/expireOffers.js` — runnable job that expires stale pending
  offers past their 7-day window.

**Commissions** (`src/services/commissionService.js`, spec section 19)
- Full state machine: `requested → proposed → accepted → in_progress →
  delivered → completed`, with `rejected`/`cancelled` exits.
- FEE GATEWAY: `'commission_request'`, charged when the buyer submits
  the initial request.
- **Honestly scoped gap, not hacked around**: commission payment/
  milestone integration is *not* wired into the order/ledger pipeline
  in this pass. A commission has no existing artwork for
  `order_items.artwork_id` (`NOT NULL`) to reference — the piece doesn't
  exist yet. Forcing it through that model would mean a fake placeholder
  artwork row, which is worse than flagging it plainly: a real
  implementation needs either a real draft-artwork-per-commission record
  or a dedicated `commission_payments` table, scoped for a Phase 7 follow-up.

**Messaging** (`src/services/messageService.js`, spec section 20)
- Conversations are derived from `messages` grouped by counterpart
  rather than a separate conversations table — simple and correct at
  current scale; flagged in comments as the thing to materialize once
  volume demands it.
- Blocking is enforced at **send time**, both directions, not just
  hidden client-side. Reporting creates an admin-reviewable
  `message_reports` row.

**Notifications** (`src/services/notificationService.js`, spec section 34)
- Every offer/commission/message event above creates an in-app
  notification. Failures here never break the calling flow (a missed
  notification is logged, not a 500). Email/push/SMS dispatch is a
  separate concern layered on top of the same `notifications` table —
  not built in this pass.

**Frontend gap closed**: earlier phases linked to `/artwork/:slug` and
an artist profile page that never actually existed. Phase 6 adds:
- `public/artwork.html` — full detail page: gallery, Add to Cart, Save
  to Wishlist, and a "Make an Offer" modal (shown only when the artist
  has enabled offers), plus the buyer's own latest offer status on that
  piece.
- `public/artist.html` — public profile with available works and a
  "Request a Commission" form.
- `public/messages.html` — a shared inbox (works for buyers and artists
  alike, since messaging isn't role-specific).
- `public/dashboard/offers.html` / `commissions.html` — artist-side
  management: accept/reject/counter an offer, propose/track a commission.

## Phase 7 additions — commission payments, certificates, shipping, disputes

**Commission payments (closing the Phase 6 gap)** — rather than bolt on
a parallel payment system, `order_items.artwork_id` is now nullable and
a new `commission_id` column lets a commission be a valid line item
through the **exact same** orders/payments/ledger pipeline as an artwork
sale (`database/phase7_schema.sql`). `commissionService.accept()` now
calls the new `orderService.createFromCommission()`, mirroring how
`offerService.accept()` already worked — zero new payment logic needed,
because it's genuinely the same system. On successful payment, the
commission auto-advances from `accepted` to `in_progress`.

**Certificates** (`src/services/certificateService.js`, spec section 21)
- Real PDF generation via `pdfkit` (pure JS, no native deps) — not a
  placeholder link. Generation failure never blocks the sale itself from
  finalizing; the certificate row and its verification page work
  regardless, and PDF generation can be retried independently.
- `GET /api/certificates/verify/:number` and `public/verify.html` — a
  genuinely public page (no auth) that returns **only** artwork/artist/
  edition fields. It is structurally incapable of leaking who bought the
  piece: the query that powers it never selects a buyer, order, or
  payment field in the first place (spec section 21's "do not expose
  sensitive buyer information publicly" isn't just a filter here — the
  data simply isn't in the query).
- Admin can invalidate a certificate (wired into the dispute "return"
  resolution below).

**Shipping / tracking** (`src/services/shipmentService.js`, spec section 23)
- One shipment per order, created automatically the moment payment is
  confirmed. Status transitions are validated against an explicit
  adjacency map (`processing → ready_for_shipment → shipped → ...`) —
  an artist can't jump a shipment straight to "delivered" from
  "processing." Every transition appends an auditable `tracking_events`
  row rather than silently overwriting status.
- `public/orders.html` (buyer) shows live tracking; `public/dashboard/artist-orders.html`
  (artist) is where shipment status actually gets updated — courier,
  tracking number, status.
- Real shipping fee calculation by destination/courier is still a
  documented TODO (`orders.shipping_fee` stays 0) — spec section 23's
  fee/rate-table integration is a reasonable Phase 8 addition once a
  courier API is chosen.

**Disputes** (`src/services/disputeService.js`, spec sections 24, 26)
- Buyer files a dispute (reason, description, evidence images) against
  a paid order; admin reviews and resolves with an explicit, auditable
  resolution type: `refund`, `partial_refund`, `return` (refund +
  certificate invalidated, since the piece is coming back), `continue`
  (no action), or `release_payout` (sides with the artist).
- Refunds are **real provider refunds**, not just a database flag — both
  the Paystack and Stripe adapters gained a `refund()` method. The
  matching ledger entries are posted as fresh reversal rows (never
  edits to the original sale entries), split proportionally between the
  platform's take and the artist's earning, and clawed back from
  whichever balance currently holds it (pending vs. available).
- `public/orders.html` lets a buyer file a dispute inline;
  `public/admin/disputes.html` is the review/resolution queue.

## Phase 8 additions — admin reporting, reviews, collections, exhibitions, marketing, blog, admin users

**Reporting & analytics** (`src/services/reportingService.js`, spec sections 28, 58)
- Dashboard overview, sales report, top artists/artworks, artist earnings
  (correctly scoped per artist via `ledger_account_id`, not a platform-wide
  total), refunds, conversion, and disputes summaries — every figure
  computed live from `ledger_entries`/`orders`, never a cached summary
  column, so reports always reconcile against the same source of truth
  reconciliationService uses.
- CSV export on sales, artist-earnings, refunds, and newsletter-subscriber
  endpoints (`?format=csv`). The admin UI fetches these with the same
  bearer token as everything else and triggers a blob download
  (`adminDownload()` in `admin-common.js`) — a plain `<a href>` can't
  carry the Authorization header this API requires.
- `public/admin/reports.html`.

**Review moderation** (`src/services/reviewService.js`, spec section 33)
- A review requires a real, delivered/completed order for that specific
  artwork — checked via `order_items`/`orders` directly, never a
  client-supplied "verified" flag. One review per (order, artwork) is
  enforced at the database level as a backstop.
- Public listings anonymize the buyer to a first name only (spec section
  59). Reporting a review flags it for admin; admin can dismiss the
  report or remove the review outright (`public/admin/reviews.html`).
- Buyers can leave a review from `public/orders.html` once an order is
  delivered/completed; reviews display on `public/artwork.html`.

**Collections & exhibitions CMS** (`src/services/collectionService.js`,
`src/services/exhibitionService.js`, spec sections 35, 36)
- Both reuse the `collections`/`exhibitions` tables already defined in
  `schema.sql` (unused until now) — curated, admin-selected sets of
  artworks with their own slug and publish state. An exhibition's
  "artists" are derived from its artworks' `artist_id` at read time, not
  stored separately, so there's nothing to fall out of sync.
- `public/admin/collections.html`, `public/admin/exhibitions.html`.
- Public browsing API exists (`GET /api/collections`, `GET /api/exhibitions`
  and their `:slug` routes); dedicated public collection/exhibition pages
  (`/collection/:slug`, `/exhibition/:slug`) are not yet built — the same
  kind of gap `artwork.html`/`artist.html` were before Phase 6, flagged
  rather than shipped half-built.
- An interactive/3D exhibition viewer remains explicit future work per
  the spec ("design the system so interactive/3D galleries can be added
  later") — not attempted here.

**Marketing** (`src/services/marketingService.js`, spec section 44)
- Featured artworks/artists: simple admin toggles on existing columns
  (`artworks.is_featured` already existed; `artist_profiles.is_featured`
  added in `phase8_schema.sql`).
- Homepage sections: admin can enable/disable and reorder the sections
  listed in spec section 3, stored as one `settings` row and read by
  whatever renders the homepage — no per-section content duplication.
- **Discount codes**: resolved and validated entirely server-side
  (`marketingService.resolveDiscount`) against the order's real subtotal,
  currency, usage caps and date window — a client can send a code, never
  a discount amount. Wired into `orderService.createFromCart`, closing
  the `discountAmount = 0 // TODO(Phase 8)` placeholder from Phase 4.
  Redemptions are recorded (`discount_code_redemptions`) so per-user and
  total usage caps are enforced correctly even under concurrent checkouts.
- **Newsletter**: public subscribe/unsubscribe (`POST /api/marketing/newsletter/subscribe`),
  admin list + CSV export.
- **Email campaigns**: full authoring/scheduling data model and admin UI
  is *not* built as a standalone page this pass (API exists:
  `GET/POST /api/admin/marketing/campaigns`, `.../queue`, `.../cancel`) —
  flagged rather than faked: there is no email-provider client wired
  anywhere in this codebase (`EMAIL_API_KEY` is reserved in `.env.example`,
  never used by an actual HTTP call to a provider). "Queueing" a campaign
  is as far as this goes; real sending needs a provider integration and a
  background worker, same honesty pattern as shipping-courier integration
  in Phase 7.
- `public/admin/marketing.html` (featured + homepage sections),
  `public/admin/discount-codes.html`.

**Blog / editorial** (`src/services/blogService.js`, spec section 43) —
not explicitly phased in the original build order, but built here since
it shares the same CMS/marketing nature as collections/exhibitions and
`blog_posts` already existed in `schema.sql`, unused. Public listing/
detail API + `public/admin/blog.html`. No dedicated public `/blog`
page yet (same flagged gap as collections/exhibitions above).

**Admin user management** (`src/services/adminUserService.js`, spec
section 31) — `super_admin`-only CRUD on `admin_users`, strictly separate
from a user's ordinary `primary_role` (an `admin_role` of `moderator`
never grants financial access — every finance-moving route already
checks `admin_role` specifically via `requireAdmin(...)`). An admin
cannot revoke their own access. General user suspend/reactivate
(generalizing spec section 29 beyond just artists) lives alongside it.
`public/admin/admin-users.html`.

## Phase 9 additions — collector accounts, resale marketplace, galleries, artist follow, view-in-room

**Resale marketplace** (`src/services/resaleService.js`, spec section 40)
- A buyer who owns an artwork (`artworks.current_owner_user_id`) can list
  that *same* artwork row for resale — never a disconnected duplicate
  record. Listing moves the artwork `sold -> resale_listed` via the same
  guarded conditional `UPDATE` pattern used everywhere else (spec section
  49); checkout reserves it `resale_listed -> sold` through
  `artworkService.reserveForCheckout`'s now-generalized `fromStatus`
  option, so a resale checkout can never cross-match a first-sale one.
- A resale purchase runs through the *exact same* orders/payments pipeline
  as a first sale (`orderService.createFromResaleListing` mirrors
  `createFromOffer`) — only the ledger postings differ
  (`resaleService.postResaleEntries`): proceeds credit the **seller** (an
  ordinary buyer-owner account, `ledger_accounts.owner_type = 'buyer'`),
  with an optional artist royalty only when the seller explicitly set
  `artistRoyaltyPercentage` on the listing — never assumed.
  `release_expired_reservations()` was updated (`phase9_schema.sql`) to
  release an expired resale reservation back to `resale_listed`, not
  `published`.
- API: `GET/POST /api/resale`, `GET /api/resale/mine`,
  `DELETE /api/resale/:id`, `POST /api/resale/:id/buy`. Frontend:
  `public/resale.html` (browse), `public/resale-detail.html` (buy), and a
  "List for Resale" action on `public/my-collection.html`.

**Collector accounts** (`src/services/collectorService.js`, spec section 38)
- An opt-in (`buyer_profiles.is_collector`) on top of an ordinary buyer
  account. `getMyCollection` returns every artwork the user currently
  owns (tracked via `current_owner_user_id`, kept accurate across both
  first sales and resales) with its certificate, full provenance trail,
  and the owner's private note — every query strictly scoped to the
  authenticated user, never exposed publicly.
- API: `POST /api/collector/activate`, `GET /api/collector/collection`,
  `GET/PUT/DELETE /api/collector/notes/:artworkId`. Frontend:
  `public/my-collection.html`.

**Galleries** (`src/services/galleryService.js`, spec section 39)
- Reuses the existing `artist_status` enum for `gallery_profiles.status`
  and the Phase 2 admin-approval pattern exactly — no new moderation
  machinery invented. Staff permissions are role-based
  (`gallery_members.role`: owner/manager/staff); the owner role can never
  be changed or removed through the staff-management endpoints.
- An artist joins a gallery's roster by their **own** action
  (`artist_profiles.gallery_id`, set only via `POST /api/galleries/:id/join`)
  — a gallery can never unilaterally claim an artist, mirroring the
  platform's existing rule that ownership/attribution changes must come
  from the party who owns the thing being changed. `artworkService.createDraft`
  auto-stamps a new artwork with the artist's current `gallery_id`
  (server-resolved, never client-supplied).
- Gallery inventory and analytics (`listInventory`, `getAnalytics`) are
  scoped to `artworks.gallery_id` and require a manage-level staff role.
- API: `POST /api/galleries/apply`, `GET /api/galleries` (public
  directory), `GET /api/galleries/me`, `GET /api/galleries/:slug`
  (public profile), `PATCH /api/galleries/:id`,
  `GET/POST /api/galleries/:id/members`,
  `PATCH/DELETE /api/galleries/:id/members/:memberId`,
  `POST /api/galleries/:id/join`, `GET /api/galleries/:id/artists`,
  `GET /api/galleries/:id/inventory`, `GET /api/galleries/:id/analytics`,
  admin approval at `GET/POST /api/admin/galleries/...`. Frontend:
  `public/galleries.html`, `public/gallery.html`, `public/gallery-apply.html`,
  `public/dashboard/gallery.html` (owner/manager dashboard — profile,
  staff, inventory, overview stats), `public/admin/galleries.html`.

**Artist follow** (`src/services/followService.js`, spec section 14)
- `artist_profiles.followers_count` is kept correct under concurrent
  follow/unfollow via atomic `increment_artist_followers`/
  `decrement_artist_followers` SQL functions (the same pattern as the
  existing artwork-favorites counter), never a read-then-write.
  `artworkService.publish()` fans out a notification to every follower
  on new artwork (best-effort — a notification failure never blocks
  publishing).
- API: `POST/DELETE /api/artists/:id/follow`,
  `GET /api/artists/me/following`, `GET /api/artists/me/followers`.
  Frontend: Follow/Unfollow button on `public/artist.html`.

**"View Artwork in Room"** (`src/services/roomViewService.js`,
`src/controllers/roomViewController.js`, spec section 37) — built
**explicitly as architecture only**, exactly as the spec asks for: *"For
the first version, create the UI and backend architecture so an
AI/image-processing service can be integrated later."* A request uploads
the user's room photo to the **private** documents bucket (never the
public artworks bucket — a photo of someone's home is at least as
sensitive as a verification document) and is stored as a
`room_view_requests` row with `status: 'pending'`. There is no
image-compositing or AI service wired into this codebase anywhere, and
this module deliberately does not fake a result (e.g. returning the
artwork or room image unchanged) — a request stays `pending` until a
real service is integrated. Flagged here, in the code's own comments,
and in the frontend's confirmation message, not silently stubbed.
API: `POST /api/room-view`, `GET /api/room-view/mine`,
`GET /api/room-view/:id`. Frontend: "View in My Room" modal on
`public/artwork.html`.

**Not attempted in this pass** (flagged, not faked): AI-powered search/
recommendations mentioned alongside Phase 9 in the spec's build-order
bullet — no ML/embedding infrastructure exists anywhere in this codebase,
and building a convincing-looking fake would be actively misleading.
Real image compositing for View in Room, similarly, needs a genuine
image-processing/AI integration this environment doesn't have.

## Getting started

```bash
cp .env.example .env    # fill in your Supabase project + secrets
npm install
```

In the Supabase SQL editor, run in order:
1. `database/schema.sql`
2. `database/functions.sql`
3. `database/rls_policies.sql`
4. `database/fees_schema.sql`
5. `database/seed_fee_types.sql`
6. `database/reconciliation_schema.sql`
7. `database/phase6_schema.sql`
8. `database/phase7_schema.sql`
9. `database/phase8_schema.sql`
10. `database/phase9_schema.sql`

Set `PAYMENT_PROVIDER` in `.env` to `paystack` or `stripe`, with the
matching secret/public/webhook keys from that provider's dashboard.
Point each provider's webhook config at
`https://your-domain/api/webhooks/payments` (order payments) and, for
Paystack, also `https://your-domain/api/webhooks/payouts` (transfer
confirmations).

Create two Storage buckets matching your `.env` (`artelia-artworks` as
**public**, `artelia-verification-docs` as **private** — this bucket now
also holds fee-payment proofs) before testing uploads.

```bash
npm run dev              # starts the API on :4000
```

Serve `public/` with any static host, or add `app.use(express.static('public'))`
to `src/app.js` for local dev.

**To exercise the full loop locally:** register a buyer, apply as an
artist (`POST /api/artists/apply`), approve them via
`/admin/moderation.html` (you'll need an `admin_users` row for your own
account — insert one directly in Supabase for now, full admin user
management is Phase 8), list + submit an artwork, approve + publish it,
then as a buyer add it to cart and check out at `/cart.html`. To see fee
management end-to-end: create an `artwork_upload` fee rule in
`/admin/fees.html`, then try submitting a new artwork — it'll be blocked
until the artist pays via `/dashboard/fees.html`.

## Build order — what to build next, and where it goes

| Phase | Scope | Where it lands |
|---|---|---|
| 2 (cont.) | Category/medium/style browsing + filter UI on a dedicated explore page | `public/explore.html` (the filtering API already exists on `GET /api/artworks`) |
| 5 (cont.) | Card settlement for standalone fees (order-checkout fees already work), a 3rd provider adapter if needed, encrypting `account_number_encrypted` at rest via KMS/pgcrypto | extend `feeController.pay`'s `card` branch; add to the `providers`/`payoutProviderService` objects; wrap the encrypt/decrypt calls where those columns are read/written |
| 7 (cont.) | Real per-courier shipping fee calculation, splitting one order's shipment per contributing artist | `shipmentService.js`, `orderService.createFromCart`'s `shippingFee` placeholder |
| 8 (cont.) | Public `/collection/:slug`, `/exhibition/:slug`, `/blog` + `/blog/:slug` pages (API already exists); real email-campaign sending via a provider client + background worker | new `public/collection.html`, `public/exhibition.html`, `public/blog.html`/`public/blog-post.html`; a `src/services/emailProviderService.js` adapter + a `src/jobs/sendQueuedCampaigns.js` job |
| 9 (cont.) | AI-powered search/recommendations; real image compositing for View in Room (architecture built, no AI service wired in) | a dedicated search/recommendation service + an image-processing provider integration for `roomViewService.js` |

## Key architectural decisions worth knowing about

- **Inventory protection**: `artworks.status` transitions are guarded by
  conditional `UPDATE` statements, not application-level locks (spec
  section 49) — extended in Phase 4 so checkout's multi-item reservation
  rolls back cleanly if any single artwork loses the race.
- **Financial ledger is append-only**: nothing ever `UPDATE`s a balance
  directly; every balance change — sales, fees, payouts, reversals — is
  the sum of ledger entries (spec section 26). Fee revenue is not a
  special case; it posts through the exact same mechanism.
- **Fees are never hard-coded**: every chargeable action resolves its
  amount at the moment it happens, from admin-configured `fee_rules`.
  Disabling a fee type or rule takes effect immediately, everywhere,
  with no code change.
- **Manual payments are never self-certified**: a bank transfer or
  crypto fee payment stays `awaiting_verification` — not `paid` — until
  an admin explicitly approves the proof. The payer's claim alone never
  moves money.
- **RBAC is two-layered**: `users.primary_role` for coarse routing,
  `admin_users.admin_role` for fine-grained admin permissions — fee
  management and payouts require `finance_admin` or `super_admin`
  specifically, so a moderator can never touch money.
- **Ownership checks happen server-side, from the authenticated session**
  — never from a client-supplied `artist_id`/`user_id`/price in the body.

## Security notes

- `.env` is git-ignored; only `.env.example` (placeholders) is committed.
- `SUPABASE_SERVICE_ROLE_KEY` and payment secret keys exist only in
  `src/config` on the server — nothing in `public/` ever references them.
- Webhook route is mounted with a raw body parser specifically so HMAC
  signatures can be verified against the exact bytes received.
- Verification documents and fee-payment proofs live in a private
  bucket; the API never returns a public URL for them, only short-lived
  signed URLs issued to the owning user or an admin.
- Bank account numbers are masked (`••••1234`) in every API response
  that isn't the admin management endpoints themselves.
- Every webhook (`/api/webhooks/payments`, `/api/webhooks/payouts`) is
  mounted with a raw body parser and verifies the provider's signature
  before any payload is trusted — mismatched signatures return 401
  without touching the database.
- `account_number_encrypted` is named for what it should be in
  production (encrypted via pgcrypto/KMS) but is stored as plaintext in
  this scaffold for clarity — wire real encryption/decryption before
  handling real bank details; this is flagged explicitly in
  `payoutProviderService.js` and `artistService.js`, not silently assumed.
- Dispute evidence images and certificate PDFs both go through the same
  signature-validated upload path as everything else (`uploadService.js`)
  — a certificate PDF is generated server-side by `pdfkit`, never
  accepted as an upload from a client.
- Discount codes are resolved and priced entirely server-side
  (`marketingService.resolveDiscount`) from the code string alone — the
  client never sends, and the server never trusts, a discount amount.
- CSV/export endpoints require the same bearer token as the JSON API;
  there is no separate unauthenticated export link. The admin UI fetches
  them with `fetch` + `Authorization` and turns the response into a blob
  download (`adminDownload()`), since a plain `<a href>` can't carry
  that header.
- Admin role management (`admin_users`) is `super_admin`-only, an admin
  cannot revoke their own access, and granting a brand-new admin account
  requires a password of at least 10 characters — hashed with the same
  `bcryptSaltRounds` config as every other account, never a shortcut.
# artelia-back
