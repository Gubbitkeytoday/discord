# Payments: donations and the Supporter badge

Nothing in the app is paywalled. Payments exist for two reasons:

1. **Support this instance.** People who find the instance useful can chip in towards hosting.
2. **The Supporter badge.** A paid donation shows a cosmetic *Supporter* badge on the payer's
   profile. That is the only perk. There are no supporter-only features, cosmetics or limits, and the
   supporter can hide the badge (Settings › Support).

Amounts are in Thai baht (THB) and stored as integer satang (1 THB = 100 satang).

Payments are **off by default**. Nothing shows in the UI, and every `/api/payments/*` route except
`/config` answers `404 PAYMENTS_DISABLED`, until you configure one of:

| Method | Needs | Fee to the instance | Confirmation |
|---|---|---|---|
| PromptPay QR, slips checked by an admin | `PROMPTPAY_ID` | **0 %** | an instance admin approves each slip |
| PromptPay QR + SlipOK | `PROMPTPAY_ID`, `SLIP_VERIFY_PROVIDER=slipok`, `SLIPOK_API_KEY`, `SLIPOK_BRANCH_ID` | 0 % on the transfer, plus the SlipOK plan | automatic, in seconds |
| PromptPay QR + EasySlip | `PROMPTPAY_ID`, `SLIP_VERIFY_PROVIDER=easyslip`, `EASYSLIP_API_KEY` | 0 % on the transfer, plus the EasySlip plan | automatic, in seconds |
| Stripe Checkout (card + PromptPay) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe's fees (below) | automatic, by webhook |

PromptPay and Stripe can be enabled together; the Support page then offers both.

---

## 1. PromptPay QR (recommended, free)

```env
PROMPTPAY_ID=0812345678          # mobile number, 13-digit national/tax id, or 15-digit e-wallet id
PROMPTPAY_NAME=Somchai J.        # the name payers will see in their banking app
PROMPTPAY_ACCOUNT=1234567890     # optional: the bank account(s) behind the PromptPay id
SLIP_VERIFY_PROVIDER=manual      # manual | slipok | easyslip
```

What happens:

1. The payer picks ฿50 / 100 / 300 / 500 or a custom whole-baht amount
   (`PAYMENTS_MIN_THB`–`PAYMENTS_MAX_THB`, default 20–50,000; presets from `PAYMENTS_PRESETS_THB`).
2. The server creates an order and returns a **dynamic Thai QR (EMVCo) payload** for your PromptPay id
   with the exact amount (`services/payments/promptpay.js`). The client draws the QR, shows the
   receiver name, a 30-minute countdown (`PAYMENTS_ORDER_TTL_MIN`) and a *Save QR* button that
   saves a PNG the payer can pick from their photos inside a banking app.
3. The payer pays in any Thai banking app and uploads the slip (drop, paste, file picker, or the
   camera on a phone). JPEG, PNG or WebP only, magic-byte checked, ≤ `PAYMENTS_SLIP_MAX_BYTES`
   (5 MB). The slip is stored as a **private** file.
4. The slip is verified (next section) and the order becomes *paid*; the payer gets a toast, the
   page turns into a thank-you, and the Supporter badge appears.

Unpaid orders with no slip expire after 30 minutes (a sweeper runs every `PAYMENTS_SWEEP_MS`).
A slip may still be sent for an expired order — someone who paid at minute 29 is not punished;
the slip's own transaction time is what gets checked.

### Manual verification (default)

With `SLIP_VERIFY_PROVIDER=manual` (or a provider whose keys are missing, or a provider that is down
or out of quota) the order waits in **Admin console › Payments** under *Awaiting review*. Open your
banking app, find the transfer, and press **Approve** (optional note) or **Reject** (a reason is
required and is shown to the payer). Both are written to the admin audit log. The console shows the
slip (via a 15-minute signed URL), totals, and warns when the same image was already used for another
order.

### Automatic verification: SlipOK or EasySlip

Both services read the verification QR printed on Thai bank slips and ask the bank whether the
transfer is real.

* **SlipOK** — create a branch in the SlipOK LINE dashboard, copy the API key and branch id.
  `SLIP_VERIFY_PROVIDER=slipok`, `SLIPOK_API_KEY`, `SLIPOK_BRANCH_ID`.
* **EasySlip** — create an application at easyslip.com and copy its access token.
  `SLIP_VERIFY_PROVIDER=easyslip`, `EASYSLIP_API_KEY`.

When the provider says a slip is genuine the server **also** checks, itself:

* the **receiver** is you: the (masked) PromptPay id or bank account on the slip matches
  `PROMPTPAY_ID` / `PROMPTPAY_ACCOUNT`. Providers return masked numbers (`xxx-xxx-5678`); every digit
  they show must match ours, and at least three must be shown;
* the **amount** is at least the order amount (overpaying is fine and recorded);
* the **time**: after the order was created (2-minute clock-skew allowance) and within 24 hours;
* the **transaction reference is unused**: `payment_orders.trans_ref` has a UNIQUE index, so the same
  slip can never pay two orders — not for another user, not in a race. The same image bytes
  (SHA-256) or the same slip-QR reference already on a paid order is refused before the provider is
  even asked.

A failed check keeps the order open (the payer may upload a different slip, up to 5 times) and tells
the payer why; an admin can still approve it by hand.

If the browser can read the slip's QR code itself (`BarcodeDetector`), it sends the payload too and
the provider is asked with that instead of the image.

> **Not verified against the live APIs.** The provider documentation sites were not reachable from
> the environment this was built in. The request/response mapping was written from the providers'
> published client libraries (`slipok`, `@prakrit_m/slipok-sdk`, `n8n-nodes-easyslip` on npm) and
> lives in exactly one function per provider (`slipokRequest`, `easyslipRequest` in
> `services/payments/slipVerify.js`). Test with a real key and a real ฿1 slip before relying on it;
> until then `manual` is the safe choice. Anything the provider answers that is not clearly
> "genuine" or clearly "not a slip" falls back to manual review.

## 2. Stripe (optional)

```env
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

1. In the Stripe dashboard (a Thailand account) enable **Cards** and **PromptPay**.
2. Add a webhook endpoint `https://<PUBLIC_URL>/api/payments/stripe/webhook` for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired` and `charge.refunded`;
   copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Make sure `PUBLIC_URL` is right — Checkout returns the payer to `PUBLIC_URL/?payment=…`.

The server talks to the fixed host `https://api.stripe.com` with `fetch` (no SDK) to create a
Checkout Session in `thb`. The webhook verifies `Stripe-Signature` (HMAC-SHA256 over
`<timestamp>.<raw body>`, constant-time, 5-minute tolerance) on the **raw** request body —
`server.js` reads that path with `express.raw` before `express.json` runs. Events are idempotent on
the event id (`payment_events` table, same transaction as the effect), so a redelivered event is a
no-op. A refund marks the order *refunded* and removes the badge unless the person has another paid
order.

## Fees (as researched September 2026 — verify before relying on them)

| | Fee |
|---|---|
| PromptPay transfer to your own PromptPay id | **0 %** (free for payer and receiver) |
| SlipOK | free tier of roughly 100 slips a month, then paid packages |
| EasySlip | paid plans (monthly quota) |
| Stripe — PromptPay | 1.65 % per successful payment (+ ฿10 per refund) |
| Stripe — domestic cards | 3.65 % + ฿10 per the brief; a September 2026 search of stripe.com/en-th/pricing showed **4.75 % + ฿10**. Check the live page. |
| Stripe — international cards / currency conversion | extra percentage on top; see Stripe's page |

For donations, PromptPay QR with manual or SlipOK verification is by far the cheapest.

## Tax and legal (Thailand) — not legal advice

* **Declare the income.** Donations received personally are generally assessable income for Thai
  personal income tax; keep the admin console export / audit log as your record.
* **VAT.** Registration is required once taxable turnover exceeds **฿1.8 million a year**.
* Money received in exchange for a badge is not a charitable donation in the tax sense; do not call
  it tax-deductible.
* If you run the instance as a company, the receipts belong in its books.

### Pages you should publish

* **Refund policy** — e.g. "Donations are voluntary and normally not refunded. If you paid by
  mistake or twice, contact us within 14 days and we will refund the transfer." Stripe expects one.
* **Terms / what supporters get** — state plainly that the only thing a payment gives is the
  Supporter badge.
* **Privacy notice (PDPA)** — slips contain names and partial account numbers: say you store them
  to verify payments, who can see them (instance admins), and how long you keep them.
* **Contact** for payment questions.

## Security

* Payments are off unless configured; the public `/api/payments/config` never exposes keys, the full
  PromptPay id or provider URLs.
* Orders: signed-in users only, rate-limited (20 per 10 min; at most 3 open unpaid orders), whole
  baht within the configured range. Only the owner or an instance admin can read an order; others
  get `404`.
* Slips: images only (JPEG/PNG/WebP by magic bytes, never by the declared type), size-capped,
  stored with `private` visibility; admins see them through short-lived signed URLs.
* Replay protection: UNIQUE `trans_ref`, plus slip-image hash and slip-QR reference checks.
* The amount, receiver and time are always checked by this server, never trusted from the client
  or taken on the provider's word alone.
* Admin approve / reject require an instance admin (`assertInstanceAdmin`), take a reason, and are
  audited (`payment_approve`, `payment_reject`; automatic payments are logged as `payment_paid`).
* Stripe: fixed API host, idempotency key per order, raw-body HMAC with timing-safe compare and a
  5-minute window, idempotent event handling, amount and currency re-checked on the event.
* `PAYMENTS_PROVIDER_BASE_URL` (pointing a slip provider at a mock) is ignored when
  `NODE_ENV=production`.

## Data

Schema v48 (`db/migrations/payments.js`): `payment_orders` (amount in satang, method, status
`pending | paid | rejected | expired | refunded`, provider refs, slip file, `trans_ref` UNIQUE,
created/expires/paid timestamps, note), `payment_events` (webhook idempotency), and
`users.supporter_since` / `users.supporter_badge_hidden`.

## API

| Route | Who |
|---|---|
| `GET /api/payments/config` | anyone |
| `POST /api/payments/orders` `{ amount_thb, method: 'promptpay' \| 'stripe' }` | signed in |
| `GET /api/payments/orders`, `GET /api/payments/orders/:id` | owner (or instance admin) |
| `POST /api/payments/orders/:id/slip` multipart `slip` (+ optional `payload`) | owner |
| `GET/PUT /api/payments/supporter` `{ badge_hidden }` | signed in |
| `POST /api/payments/stripe/webhook` | Stripe (signature) |
| `GET /api/admin/payments?status=&method=&q=` | instance admin |
| `POST /api/admin/payments/:id/approve` `{ reason?, trans_ref? }`, `…/reject` `{ reason }` | instance admin |

Socket: `payment_updated` `{ order, paid }` to the payer; `identity_updated` when the badge changes.

Tests: `scripts/test-payments-48.mjs` (SQLite and PostgreSQL) with a mocked slip provider and
injected `fetch` — the real internet is never called.
