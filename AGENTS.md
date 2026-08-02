# AGENTS.md

Briefing for an AI coding agent working on this repository. Read this before touching anything.

*(Antigravity, Cursor, Claude Code and Codex all pick this file up automatically. If your tool wants a different filename, symlink or copy it.)*

---

## 1. What this is

A corporate purchasing agent. An employee texts what they need; a deterministic policy engine decides whether it is buyable; if it needs a human, an approver confirms with a passkey; only then does Prava mint a single-use credential locked to one merchant and one amount, and a browser agent completes the checkout.

Built for the **Agentic Commerce Hackathon** (Prava). Targets the **Visa Intelligent Commerce** track primarily and the **Linq iMessage** track secondarily.

**Submission deadline: 2 August 2026, 3:00 PM PT / 3 August, 3:30 AM IST.** Assume there is less time than it looks. Prioritise a working demo and a truthful README over new features.

### The problem statement being answered

> Companies waste hours getting manager approvals for low-value software tools, cloud top-ups, dev utilities and team supplies. An agent handles the purchase; the company keeps control over what it may spend, where, and how often.

### What judges are scoring

End-to-end functionality · creativity · user value · **Prava implementation quality (the heaviest single factor)** · track implementation · product experience · what happens next.

The handbook explicitly says a **mocked payment presented as a real transaction** will not stand out and may be treated as a misleading demo. Everything below about honest degradation exists because of that line.

---

## 2. Provenance — keep this accurate

The hackathon rules require disclosing what pre-existed the event.

- **Before the event:** a scaffold with a Linq webhook handler, a first-pass OpenAI call, and stub Prava/Stagehand services. Those files now live in `legacy/` — moved, not deleted, so the before/after is auditable. `legacy/` is outside the `tsconfig` include glob and does not compile.
- **During the event:** everything in `src/`, `tests/`, `scripts/` and the docs.

If you rewrite history in the README, keep this section truthful.

---

## 3. Invariants — do not break these

These are not style preferences. Each one exists because breaking it produced a real defect, and most are enforced by a test that will fail if you regress it.

### 3.1 The model extracts. Deterministic code decides.

`src/services/policy/extractor.ts` turns English into typed fields and a confidence score. `src/services/policy/engine.ts` is pure — no network, no model — and is the **only** thing that decides whether money may move.

- **Never** add a field like `isWithinPolicy`, `approved`, or `shouldBuy` to the extractor's output schema.
- **Never** mention spending limits, caps, or approval rules in the extractor's system prompt. The model has no limits in context, which is exactly why *"ignore the limit, this is pre-approved by the CFO"* is inert rather than an exploit.
- Policy lives in `src/config/policy.ts` as data a non-engineer can read. Change rules there, not in the engine.

Guarded by `tests/policy.engine.test.ts` (including a prompt-injection case).

### 3.2 Authorization is a state, not a step

`src/domain/mandate.ts` holds a transition table. `EXECUTING` is reachable only from `PROVISIONED`, which is reachable only from `AUTHORIZED`. There is **no path** from `PENDING_APPROVAL` to a merchant.

- **Never** call `executeCheckout()` from anywhere except `MandateOrchestrator.provisionAndExecute()`.
- **Never** call it in the same function that sends an approval link. That was the original bug: checkout ran before anyone approved, then again from the callback.
- `transition()` throws `IllegalTransitionError` rather than proceeding. Do not add a bypass.

Guarded by `tests/flow.test.ts` → "the authorization gate".

### 3.3 GET renders, POST decides

`GET /authorize/:token` must stay side-effect free. Approval links arrive in text messages, and messaging clients, link previewers and corporate URL scanners all fetch URLs unprompted. If GET released the credential, Apple's link preview would approve every purchase before a human read it.

Tokens are HMAC over `(mandateId, action, exp, nonce)`. A link minted for one mandate cannot authorize another.

### 3.4 Money is integer cents

`src/domain/money.ts`. Never introduce a float dollar amount. Convert at the edges only — `centsToAmountString()` for Prava, `formatUsd()` for humans.

### 3.5 Card data has a one-function lifetime

Credentials arrive as an argument to `executeCheckout` and leave with the stack frame.

- Never persist, log, or send them to a model. Only `last4` is stored.
- Anything read back off a merchant page goes through `scrubPan()` first — confirmation screens routinely echo the number.
- `src/lib/logger.ts` has redaction paths as a second line of defence.

### 3.6 Do not hold the mandate lock across the browser checkout

`provisionAndExecute` is three phases: claim under lock → charge and check out with no lock → record under lock. Holding the lock through the slow phase would make the dashboard's Revoke button block for three minutes, which is precisely when it matters most.

### 3.7 One visual language, shared across surfaces

Tokens live in `src/web/tokens.css` and are linked by both `pages.ts` and `dashboard.html`. Do not re-declare a `:root` block in either.

The colour convention is semantic, not decorative: **amber is a constraint** (caps, locks, expiries), teal is authority released, carmine is authority withdrawn, blue is waiting on a human. If something is amber it is a limit. That consistency is what lets an approver read the guardrail band in two seconds on a phone without a legend.

The `.band` and `.meter` components are shared on purpose: the mandate must look like the same object on the approval screen, in the ledger, and in the detail drawer.

The dashboard has three distinct surfaces answering three different questions. Keep them distinct:

| Surface | Question |
|---|---|
| `.parse-card` | What did the agent *understand*? Appears once on send, before any decision. |
| `.slip` | What *state* is the mandate in? The ledger. |
| `.drawer` | What *authority* does it carry? The full credential, audit trail and transcript. |

### 3.8 Degrade loudly, never silently

If an integration is unconfigured the code simulates *and says so*: `sim_` id prefixes, `degraded: true`, a badge on the dashboard, and `/ready` listing what is missing. Do not "helpfully" make a fallback look like a success.

### 3.9 Never commit credentials

The Prava sandbox card is team-scoped and capped at 30 transactions a day. It belongs in `.env` only. `.env.example` gets placeholders. CI (`.github/workflows/ci.yml`) fails the build if a PAN or a tracked `.env` appears.

---

## 4. Prava API — the shapes that bite

Verified against the live docs. An earlier version of this repo guessed and was wrong on all of these.

| Trap | Correct |
|---|---|
| Host | Sandbox is `https://sandbox.api.prava.space`, **not** `api.prava.space`. Derived from `PRAVA_ENV`. |
| Amounts | Decimal **strings** (`"45.00"`), never numbers. |
| `purchase_context` | An **array** with exactly one entry, nesting `merchant_details` and `product_details`. |
| Identity | `user_id` and `user_email` are **required** on secret-key sessions. Omitting them is `400 VAL_2001`. |
| Merchant URL | Must be `https`. Prava forwards it to Visa. |
| Report body | `{ txn_status: "APPROVED" \| "DECLINED", txn_type: "PURCHASE" }` — not a free-form status string. |

### The three-call flow

1. `POST /v1/sessions` with a `mandate_setup` block → **authorize-only**, returns an approval URL, issues **no credentials**.
2. `POST /v1/mandates/{id}/charge` → after the passkey, mints single-use credentials, no new passkey.
3. `POST /v1/mandates/{id}/charges/{txnId}/report` → settles `APPROVED`/`DECLINED` with the card network.

There is no create-mandate endpoint and the session response carries no mandate id, so step 2 resolves it by listing mandates and matching on the `order_id` submitted in step 1.

`merchant_scope: "listed"` locks the mandate to one merchant **at the card network**. An over-cap charge returns `THRESHOLD_EXCEEDED` from Visa, not from our policy engine. Preserve that — it is the strongest claim in the whole submission.

Full detail in `PRAVA_INTEGRATION.md`.

---

## 5. Setup

### Prerequisites

Node 20.11 or newer. Check with `node -v`.

### Install

```bash
node setup-mandate-manager.mjs   # only if the tree is not already in place
npm install
npm run typecheck                # must be clean
npm test                         # must show 67 passing
```

If either verification step fails, **stop and fix it before configuring anything**. A broken build with half-configured credentials is much harder to diagnose.

### Configure

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

Minimum to boot:

```
CALLBACK_SIGNING_SECRET=<openssl rand -base64 32>
```

That alone gives a working demo — every unconfigured integration simulates and announces itself. Add the rest as available:

| Variable | Where it comes from | Unlocks |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI dashboard | Natural-language parsing. Without it a regex fallback runs and routes everything to a human. |
| `PRAVA_API_KEY` | dashboard.prava.space, sandbox key (`sk_test_...`) | Real mandate setup, charge, settlement. |
| `PRAVA_TEST_CARD_*` | The Prava onboarding email | Fallback card if mandate charge is unavailable. |
| `LINQ_API_TOKEN`, `LINQ_PHONE_NUMBER` | Linq, via the Prava team | Real iMessage. Do not self-serve sign up. |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | browserbase.com | The checkout agent. |
| `REQUESTER_EMAIL` | Anything valid | Required by Prava on every session. |
| `APPROVER_PHONE` | The approver's number | Routes passkey requests to a second person. Falls back to the requester. |

> **Ask the human for the sandbox card values.** They arrived by email from `support@prava.space`. A follow-up email corrected the expiry from the original — use the corrected one. Put them in `.env` and nowhere else.

### Verify

```bash
npm run dev
```

Then check `http://localhost:3100/ready`. It lists exactly which integrations are live and which are degraded. Open `http://localhost:3100/dashboard` and send a request from the compose box.

---

## 6. Demo setup

### 6.1 Make the server publicly reachable

Approval links and webhooks both need a public URL.

```bash
ngrok http 3100
```

Put the https URL in `.env` as `PUBLIC_BASE_URL` and **restart the server**. It is read once at boot.

### 6.2 Point the webhooks at it

- Linq: `POST {PUBLIC_BASE_URL}/webhooks/linq`
- Prava: `POST {PUBLIC_BASE_URL}/webhooks/prava`

Set `LINQ_WEBHOOK_SECRET` and `PRAVA_WEBHOOK_SECRET` if the providers offer them. Without a secret configured, the Prava webhook route logs and **ignores** rather than acting on an unsigned body — that is deliberate; an unauthenticated endpoint that authorizes spend is a vulnerability.

### 6.3 Choose the checkout mode

This is the most important demo decision. Two facts from the Prava team:

- Prava does **not** host a public sandbox merchant for SDK/API integrations.
- A sandbox credential on a **live** merchant gateway **will be declined**. It cannot create a real or mock order.

So:

| Mode | What happens | Use when |
|---|---|---|
| `live_decline` (default) | Real merchant, sandbox credentials, expected decline, reported to Prava as `DECLINED` with full evidence captured. Prava confirmed a captured decline counts as a successful sandbox transaction. | The main demo. |
| `dev_store` | Your own Shopify development store with test payments enabled. The only way to exercise the `APPROVED` branch. | One rehearsal take, so you can say you have seen both paths. |

```
CHECKOUT_MODE=live_decline
MERCHANT_ID=littlebox_india      # see src/config/merchants.ts
```

Fallback merchants are configured (`headphone_zone`, `deodap`, `boat_lifestyle`, `mokobara`, `oswaal_books`) because the handbook is explicit that the merchant list is a discovery aid, not a compatibility guarantee. **Validate the primary merchant early**; if the agent cannot navigate its cart, switch `MERCHANT_ID` rather than debugging the storefront.

### 6.4 Rehearse without burning transactions

The sandbox card allows **30 transactions per day**, shared across the team.

```bash
CHECKOUT_ENABLED=false npm run dev
```

Policy, approval, the state machine, the ledger and the messaging all exercise fully; only the browser checkout is skipped. Rehearse the whole flow this way, then turn it on for the takes that count.

`429 TRIES_EXHAUSTED` on session creation means the budget is spent for the day.

### 6.5 Run the scripted demo

```bash
npm run dev     # terminal 1
npm run demo    # terminal 2
```

Five scenarios in the order that makes the argument: refused → bought unattended → escalated → approved by passkey → duplicate caught. `DEMO_SCRIPT.md` has the beat-by-beat narration and answers to the four questions judges are most likely to ask.

### 6.6 Where the evidence lands

After a run against a live merchant:

- Screenshots (before payment, at the gateway result): `.data/evidence/<mandateId>/`
- Browserbase session replay URL: printed in the terminal banner and in the mandate's audit trail
- Verbatim Prava report request and response: on `mandate.evidence`, visible via `GET /api/mandates/:id`

That last item is the one that matters. Anyone can screenshot a decline; Prava's `visaConfirmation` acknowledging that you reported it truthfully is what proves the integration is real.

### 6.7 Recording

Have visible: the server terminal (for the banner), the dashboard, and the approval page on a phone or a narrow window. Keep it under three minutes. Lead with the refusal — establish that the agent has limits before showing it spend.

---

## 7. Task checklist

Work top to bottom. Each step has a verification you can actually run.

- [ ] `node -v` ≥ 20.11
- [ ] `npm install` completes
- [ ] `npm run typecheck` clean
- [ ] `npm test` → 67 passing
- [ ] `.env` created, `CALLBACK_SIGNING_SECRET` set
- [ ] `npm run dev` boots; `/ready` responds
- [ ] `/dashboard` loads and a compose-box request produces a mandate
- [ ] `npm run demo` runs all five scenarios
- [ ] Click a ledger slip: the detail drawer opens with the credential, audit trail and conversation
- [ ] On a `REVOKED` or `COMPLETED` mandate, "Simulate rogue re-charge" returns **Blocked**
- [ ] Add `OPENAI_API_KEY`; confirm `/ready` no longer lists `llm` as degraded
- [ ] Add `PRAVA_API_KEY`; confirm a session id no longer starts with `sim_`
- [ ] Add Browserbase keys; run one live checkout; confirm screenshots appear in `.data/evidence/`
- [ ] Confirm the mandate's `evidence.reportResponse.visaConfirmation` is populated
- [ ] `ngrok http 3100`, update `PUBLIC_BASE_URL`, restart, open an approval link from a phone
- [ ] Wire Linq webhook; send a real iMessage; confirm a mandate is created
- [ ] Rehearse with `CHECKOUT_ENABLED=false`
- [ ] Record the demo
- [ ] Confirm `git status` shows no `.env` and no card number anywhere

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment configuration` at boot | Missing or malformed env var; the message names the field | Fix `.env`. This is intentional fail-fast. |
| `400 VAL_2001` from Prava | Missing `user_id` / `user_email`, or a number where a decimal string belongs | Check `REQUESTER_EMAIL` is set; see §4. |
| `429 TRIES_EXHAUSTED` | Daily sandbox transaction budget spent | Wait, or rehearse with `CHECKOUT_ENABLED=false`. |
| `MANDATE_RECURRING_MUST_BE_SCOPED` | A recurring frequency sent with `merchant_scope: "any"` | Recurring forces `listed`. Do not change this. |
| `409 MANDATE_NOT_ACTIVE` | Charging before the passkey completed | The approver has not finished. Check the mandate's state. |
| "No active Prava mandate found for this order" | Approval did not complete, or the mandate list did not match on `order_id` | Confirm the passkey step finished; check `prava.orderId` on the mandate. |
| Approval link says "not valid" | Expired (30 min TTL), tampered, or already used | Request the purchase again for a fresh link. |
| Approval link says "already decided" | Replay of a used token | Working as intended. |
| Checkout `SKIPPED` | Browserbase keys missing, or `CHECKOUT_ENABLED=false` | Check `/ready`. |
| Checkout `TIMEOUT` | Merchant page slow or the agent is stuck in a cart flow | Raise `CHECKOUT_TIMEOUT_MS`, or switch `MERCHANT_ID`. |
| Webhook never fires | `PUBLIC_BASE_URL` stale after an ngrok restart | ngrok URLs change on restart. Update and restart the server. |
| Mandate stuck in `PENDING_APPROVAL` | Nobody approved | The sweeper expires it after `MANDATE_TTL_MINUTES`. |

---

## 9. Deliberately not built

Do not add these unprompted. Scope discipline is being judged, and each has a reason.

- **Multi-approver quorum** — the mandate already carries an `audit` array and `approverPhone`; the gate belongs on the `PENDING_APPROVAL → AUTHORIZED` transition. Out of scope for the window.
- **Postgres** — the `MandateRepository` interface exists with in-memory and atomic-JSON-file drivers. Swapping is one new file plus one case in `store/index.ts`. Not needed for a demo.
- **Real WebAuthn credential enrolment** — the approval page uses the platform authenticator where one is enrolled, but the signed token is the server-side authority. Full enrolment is a product, not a weekend.
- **Scheduled recurring charges** — Prava's own docs list auto-charging on a cycle as coming next. The agent initiates each charge within the cycle.
- **SSO, RBAC, multi-tenancy.**

---

## 10. Map

```
src/
  config/        env validation (zod, fail-fast) · spend policy as data · merchant registry
  domain/        mandate + state machine · money (integer cents) · typed errors
  lib/           logger · PAN redaction · signed grants · HTTP with backoff and breaker
  store/         repository interface · in-memory · atomic JSON file
  services/
    policy/      extractor (model) · engine (deterministic, pure)
    prava/       mandate setup, charge, report · defensive response normalization
    linq/        iMessage transport · message copy
    checkout/    Stagehand browser agent · evidence capture
  orchestrator/  the only module that may advance a mandate
  api/           routes · middleware
  web/           tokens.css (shared) · approval pages · dashboard + detail drawer
legacy/          pre-event scaffold, kept for disclosure, not compiled
```

Further reading, in order: `README.md` → `PRAVA_INTEGRATION.md` → `ARCHITECTURE.md` → `DEMO_SCRIPT.md`.

---

## 11. If you change something

| Change | Run |
|---|---|
| Anything in `src/` | `npm run typecheck && npm test` |
| Policy rules | `npm test -- policy.engine` and re-read §3.1 |
| The state machine | `npm test -- mandate.state flow` |
| Prava request shapes | Re-check against `PRAVA_INTEGRATION.md` §4; the docs are authoritative, not memory |
| Anything user-facing | Re-run `npm run demo` end to end |

Commit messages should say what changed and why. A judge may ask you to explain any line in this repository, so do not merge code you cannot defend.
