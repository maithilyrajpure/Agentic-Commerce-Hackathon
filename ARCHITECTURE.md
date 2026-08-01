# Architecture

## The one idea

Everything here exists to make a single sentence true:

> Software may move company money only by advancing a **mandate** through a legal state transition.

A mandate is a scoped, revocable, time-boxed grant of authority: one merchant, one ceiling, N uses, an expiry. The language model, the messaging layer, and the browser agent are actuators hanging off that record. None of them can spend money except by driving a mandate forward, and the transition table decides what "forward" means.

## Flow

```
 iMessage ──▶ POST /webhooks/linq
                 │ ack 200 immediately (a retried webhook is a duplicate purchase)
                 ▼
            extractor (gpt-4o)          ── structured fields + confidence, no verdict
                 ▼
            policy engine (pure)        ── the only thing that decides
                 │
     ┌───────────┼────────────────────┐
     ▼           ▼                    ▼
  REJECTED   AUTHORIZED         PENDING_APPROVAL
                 │                    │  Prava session created
                 │                    │  signed link → approver
                 │                    ▼
                 │              GET /authorize/:token   (renders only)
                 │              POST /authorize/:token  (the consent)
                 │                    │
                 └────────┬───────────┘
                          ▼
                     PROVISIONED   ── Prava issues a card locked to the mandate
                          ▼
                      EXECUTING    ── Stagehand at the merchant
                          ▼
              COMPLETED / DECLINED / FAILED
                          ▼
              reportStatus → Prava   ── loop closed
              receipt → iMessage
```

## State machine

`src/domain/mandate.ts` holds the transition table, and the table is the security model.

| From | May go to |
|---|---|
| `DRAFT` | `REJECTED` · `PENDING_APPROVAL` · `AUTHORIZED` · `EXPIRED` |
| `PENDING_APPROVAL` | `AUTHORIZED` · `REJECTED` · `EXPIRED` · `REVOKED` |
| `AUTHORIZED` | `PROVISIONED` · `FAILED` · `EXPIRED` · `REVOKED` |
| `PROVISIONED` | `EXECUTING` · `FAILED` · `EXPIRED` · `REVOKED` |
| `EXECUTING` | `COMPLETED` · `DECLINED` · `FAILED` |
| terminal states | nothing |

Read the `PENDING_APPROVAL` row: there is no edge to `PROVISIONED` or `EXECUTING`. A mandate awaiting a human cannot reach a merchant, no matter what any caller believes. `transition()` throws `IllegalTransitionError` rather than proceeding, so the failure is loud and testable.

## Concurrency

Two Prava webhook deliveries 5ms apart must not both read `PROVISIONED` and both start a checkout.

`MandateRepository.withLock(id, fn)` is a promise-chain mutex keyed by mandate id. Every mutation goes through it. Critical sections run in strict arrival order, and a throw inside one does not poison the next.

Execution is split into three phases so the lock is not held across the slow part:

1. **under lock** — claim: `AUTHORIZED → PROVISIONED`, set `executionLockedAt`
2. **no lock** — issue the card, drive the merchant checkout (minutes)
3. **under lock** — record the outcome

Holding the lock through phase 2 would make the dashboard's Revoke button block for three minutes, which is precisely when you most want it to work.

## Trust boundaries

| Boundary | How it is defended |
|---|---|
| Employee's message text | Never reaches the deciding code. The extractor returns fields; the engine sees only fields. |
| Approval link in a text message | HMAC over `(mandateId, action, exp, nonce)`. GET is safe; POST carries consent. Referrer policy `no-referrer`. |
| Prava webhook | HMAC over the raw body bytes. Unsigned bodies are logged and ignored, never acted on. |
| Linq webhook | HMAC when a secret is configured. |
| Card data | Lives in one function's scope. Never stored, logged, or sent to a model. Only `last4` persists. `scrubPan` runs over everything read back off a page. |
| Outbound API responses | `toPublicMandate` strips the authorization URL and all card material. |

## Why the LLM does not decide

An earlier iteration had the model return `isWithinPolicy`. Three problems:

1. **Not reproducible.** The same request can get different verdicts. There is no defensible audit answer to "why was this approved?"
2. **Steerable by its input.** The text being classified is written by the person who benefits from a yes.
3. **Not inspectable.** A finance team cannot read a prompt and know what will be approved.

The split fixes all three. `config/policy.ts` is data a non-engineer can read. `services/policy/engine.ts` is pure and unit-tested. The model does the part it is genuinely good at — turning messy English into fields — and reports a confidence score, which is itself a policy input: a weak parse routes to a human rather than acting.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| OpenAI down | Regex fallback, confidence capped below the auto-approve threshold, so everything escalates. |
| Prava down | `sim_`-prefixed session, `degraded: true` recorded, visible badge on the dashboard. Never presented as success. |
| Browserbase down | Mandate resolves `FAILED`, reported to Prava, requester told no money moved. |
| Linq down | Retried with jittered backoff; a failed receipt never rolls back a payment that succeeded. |
| Upstream flapping | Circuit breaker opens after 5 failures, 30s cooldown, half-open probe. |
| Mandate never approved | Sweeper expires it every 60s so it stops holding budget. |
| Process restart | Atomic write-then-rename JSON store reloads state. |

## Extending it

**Postgres:** implement `MandateRepository` (10 methods) and add a case in `store/index.ts`. Nothing above the store layer changes.

**Slack instead of iMessage:** implement the `LinqClient` surface (`send`) and a payload parser. The orchestrator takes a phone-shaped identifier and does not care what is behind it.

**Multi-approver:** the mandate already carries an `audit` array and an `approverPhone`. Add an approvals array and gate the `PENDING_APPROVAL → AUTHORIZED` transition on quorum. The state machine is where that check belongs.
