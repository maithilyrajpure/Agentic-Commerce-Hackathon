# Prava integration

## Why this uses Prava's Mandate API, not a card-issuance flow

Prava already models the exact thing this product is about. From their docs, a mandate is *a standing spending authorization: the owner approves it once with a passkey, after which an agent can charge that card again and again within caps, without re-approval.*

That is the product. So the integration uses that primitive directly rather than inventing a parallel one. The practical consequence is that the constraints live in the credential and are enforced at the card network, not in our policy engine's opinion. An over-cap charge does not get past us and then succeed — it comes back `THRESHOLD_EXCEEDED` from Visa.

Our local state machine deliberately mirrors Prava's lifecycle:

| Ours | Prava | Meaning |
|---|---|---|
| `PENDING_APPROVAL` | `pending` | awaiting the passkey |
| `AUTHORIZED` / `PROVISIONED` | `active` | chargeable |
| `COMPLETED` | `consumed` | one-time charge settled |
| `REVOKED` | `cancelled` | authority withdrawn |
| `EXPIRED` | `expired` | validity window lapsed |

## The three calls

### 1. Mandate setup — `POST /v1/sessions`

Sent when policy says a human must approve. The `mandate_setup` block makes the session **authorize-only**: it returns an approval URL and `authorizeOnly: true`, and issues **no credentials**. This is the technical fact that makes the product's central claim true — at the moment the approver receives the link, nothing spendable exists yet.

```jsonc
{
  "user_id": "15550100200",
  "user_email": "purchasing@yourteam.test",
  "total_amount": "45.00",              // decimal STRING, not a number
  "currency": "USD",
  "purchase_context": [{                 // ARRAY, exactly one entry
    "merchant_details": {
      "name": "Littlebox India",         // sanitized to a Visa-safe charset
      "url": "https://littleboxindia.com", // must be https, forwarded to Visa
      "country_code_iso2": "IN"
    },
    "product_details": [
      { "description": "2 designer seats", "unit_price": "22.50", "quantity": 2 }
    ],
    "effective_until_minutes": 30
  }],
  "mandate_setup": {
    "intent": "mandate_setup",
    "recurring_frequency": "monthly",
    "merchant_scope": "listed",          // locks to this merchant at the network
    "max_charges": 1
  }
}
```

Three things here bite anyone who builds from intuition, and all three were wrong in this repo's first version: amounts are decimal **strings**, `purchase_context` is an **array**, and `user_id`/`user_email` are **required** on secret-key sessions.

`merchant_scope: "listed"` is not optional for us anyway — a recurring frequency forces it, and sending `any` returns `MANDATE_RECURRING_MUST_BE_SCOPED`.

### 2. Charge — `POST /v1/mandates/{id}/charge`

After the passkey. Mints single-use credentials with **no** new passkey, because the standing authorization already covers it.

There is no create-mandate endpoint and the session response carries no mandate id, so we resolve it by listing mandates and matching on the `order_id` we submitted. `reference` is the idempotency key, so a retried checkout reuses the existing charge instead of burning a second one against `max_charges`.

Returns `{ transactionId, credentials: { token, dynamicCvv, expiryMonth, expiryYear } }`. The `token` is a network token, not a PAN, and it is single-use. We persist the last four and nothing else.

### 3. Report — `POST /v1/mandates/{id}/charges/{txnId}/report`

`{ "txn_status": "APPROVED" | "DECLINED", "txn_type": "PURCHASE" }`

This is not bookkeeping. Until it is called, Prava holds a transaction awaiting a result, the mandate's charge budget is never released, and nothing reconciles. Prava's guidance is explicit: always report after using credentials, and report `DECLINED` when they were used but checkout failed.

Reporting a one-time mandate `APPROVED` moves it to `consumed`. The response carries `visaConfirmation`, which we store as evidence.

## The two sandbox checkout modes

Set with `CHECKOUT_MODE`. This exists because of two facts the Prava team confirmed directly:

- Prava does not host a public sandbox merchant for SDK/API integrations.
- A sandbox credential presented to a live merchant's gateway **will be declined**. It cannot produce a real or mock order.

Pretending otherwise would be the "mocked payment presented as a transaction" the handbook says will not stand out. So both honest paths are implemented and the active one is labelled everywhere — the dashboard, the receipt, the terminal banner, and `/ready`.

### `live_decline` (default)

Drive a real merchant from the Prava merchant list with sandbox credentials, capture the decline, report it as `DECLINED`.

Prava's guidance was that a decline captured and included in the demo counts as a successful sandbox transaction. So the decline is treated as the deliverable, and the agent collects a proper evidence pack around it:

- the gateway's verbatim text, scrubbed of any echoed card number
- screenshots before payment entry and at the gateway result, written to `EVIDENCE_DIR`
- the Browserbase session replay URL
- the exact `report` request body and Prava's exact response, stored verbatim on the mandate

That last item is the important one. Anyone can screenshot a decline; the evidence that the *integration* is real is the signed acknowledgement from Prava that we told them the truth about it.

### `dev_store`

Point the harness at your own Shopify development store with test payments enabled, where a card can actually authorize. This is the only way to exercise the `APPROVED` branch end to end, and it is worth doing once before the demo so you have seen both paths work.

```bash
CHECKOUT_MODE=dev_store
DEV_STORE_URL=https://your-dev-store.myshopify.com
```

## Merchants

`src/config/merchants.ts` carries entries from the hackathon merchant list, including Littlebox India (`https://lbindia.myshopify.com/api/ucp/mcp`). Switch with `MERCHANT_ID`.

Note that a published UCP endpoint does not change the decline behaviour — the sandbox credential is refused by the live payment gateway regardless of how the storefront is discovered. The handbook is also clear that the list is a discovery aid rather than a compatibility guarantee, so validate your merchant early and keep a fallback configured. `headphone_zone` and `deodap` are included for that reason.

## Sandbox limits

Test cards are capped at **30 transactions per day** and are scoped to your team. `429 TRIES_EXHAUSTED` on session creation means that budget is spent; the client surfaces it with that wording rather than as a generic outage, because at 2am the distinction matters.

Rehearse with `CHECKOUT_ENABLED=false` so policy, approval, and the ledger all exercise without consuming transactions. Spend them on the takes that count.

## Environments

| | |
|---|---|
| sandbox | `https://sandbox.api.prava.space` |
| production | `https://api.prava.space` |

`PRAVA_ENV` selects the host, so a sandbox key cannot be pointed at the live API by forgetting to change a URL. Production access for the hackathon is temporary, request-only, and revoked after August 8.
