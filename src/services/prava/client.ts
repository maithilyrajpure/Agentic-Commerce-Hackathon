import { capabilities, env } from '../../config/env.js';
import { resolveMerchant, type MerchantRecord } from '../../config/merchants.js';
import { UpstreamError } from '../../domain/errors.js';
import type { Mandate } from '../../domain/mandate.js';
import { describeHttpError, HttpClient } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import {
  centsToAmountString,
  normalizeMandateList,
  PRAVA_ROUTES,
  visaSafeName,
  type ChargeMandateRequest,
  type ChargeMandateResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type MandateCredentials,
  type PravaMandateSummary,
  type PurchaseContextEntry,
  type PaymentResultResponse,
  type ReportChargeRequest,
  type ReportChargeResponse,
  type ReportSessionStatusRequest,
} from './types.js';

/**
 * Prava integration, built on Prava's own Mandate primitive.
 *
 * This matters more than it looks. Prava already models exactly the thing this
 * product is about: a standing spend authorization the owner approves once with
 * a passkey, which an agent may then charge within caps without asking again.
 * An earlier version of this file invented a parallel "issue a card" flow. That
 * was a worse design, because the constraints lived in our code rather than in
 * the credential, and it was not what the API actually offers.
 *
 * The real sequence is three calls:
 *
 *   1. createMandateSession  POST /v1/sessions with a `mandate_setup` block.
 *      Authorize-only: returns an approval URL and issues NO credentials.
 *      This is what we send the approver.
 *
 *   2. chargeMandate         POST /v1/mandates/{id}/charge, after the passkey.
 *      Mints single-use credentials. No passkey needed, because the standing
 *      authorization already covers it, bounded by the caps set at setup.
 *
 *   3. reportCharge          POST /v1/mandates/{id}/charges/{txn}/report.
 *      Settles APPROVED or DECLINED with the card network. Reporting a
 *      one-time mandate APPROVED moves it to `consumed`.
 *
 * Our local mandate state machine mirrors Prava's lifecycle deliberately:
 * pending → active → consumed / cancelled / expired.
 */

export interface MandateSessionResult {
  sessionId: string;
  approvalUrl: string;
  orderId?: string;
  expiresAt?: string;
  authorizeOnly: boolean;
  degraded: boolean;
  degradedReason?: string;
}

export interface ChargeResult {
  ok: boolean;
  pravaMandateId?: string;
  transactionId?: string;
  orderId?: string;
  credentials?: MandateCredentials;
  /** Set when Prava itself refused, e.g. THRESHOLD_EXCEEDED on an over-cap charge. */
  declineReason?: string;
  detail: string;
}

/** Outcome of the session-level settlement call (walkthrough step 4). */
export interface SessionReportResult {
  ok: boolean;
  detail: string;
  request?: ReportSessionStatusRequest;
  response?: Record<string, unknown>;
}

/** What a payment-result poll yielded that the caller actually needs. */
export interface PaymentResultSummary {
  ok: boolean;
  detail: string;
  status?: string;
  orderId?: string;
  txnRefId?: string;
}

export interface ReportResult {
  ok: boolean;
  detail: string;
  /** The exact response body, kept verbatim as transaction evidence. */
  response?: ReportChargeResponse;
  request?: ReportChargeRequest;
}

export class PravaClient {
  private readonly http: HttpClient;
  readonly merchant: MerchantRecord;

  constructor(apiKey: string = env.PRAVA_API_KEY, baseUrl: string = env.PRAVA_API_BASE) {
    this.http = new HttpClient({
      name: 'prava',
      baseURL: baseUrl,
      timeoutMs: 25_000,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      retry: { attempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 },
    });
    this.merchant = resolveMerchant({
      mode: env.CHECKOUT_MODE,
      merchantId: env.MERCHANT_ID,
      devStoreUrl: env.DEV_STORE_URL,
      devStoreName: env.DEV_STORE_NAME,
    });
  }

  /** The single purchase_context entry Prava expects, built from a mandate. */
  private purchaseContext(mandate: Mandate, merchant: MerchantRecord): PurchaseContextEntry[] {
    const minutes = Math.max(
      1,
      Math.round((new Date(mandate.scope.expiresAt).getTime() - Date.now()) / 60_000),
    );
    return [
      {
        merchant_details: {
          name: visaSafeName(merchant.name),
          url: merchant.url,
          country_code_iso2: merchant.country,
          category: merchant.category.slice(0, 100),
        },
        product_details: [
          {
            description: mandate.purpose.slice(0, 200) || 'Business purchase',
            unit_price: centsToAmountString(
              mandate.seats && mandate.seats > 1
                ? Math.round(mandate.amountCents / mandate.seats)
                : mandate.amountCents,
            ),
            product_id: mandate.id.slice(0, 50),
            quantity: mandate.seats && mandate.seats > 1 ? mandate.seats : 1,
          },
        ],
        effective_until_minutes: minutes,
      },
    ];
  }

  // -- 1. Mandate setup ----------------------------------------------------

  /**
   * Create the authorize-only session whose URL the approver opens.
   *
   * Note `merchant_scope: 'listed'`: the mandate is locked to this merchant at
   * the card network, not merely in our policy engine. A recurring frequency
   * forces `listed` anyway — sending `any` returns MANDATE_RECURRING_MUST_BE_SCOPED.
   */
  async createMandateSession(
    mandate: Mandate,
    callbackUrl?: string,
    merchant: MerchantRecord = this.merchant,
  ): Promise<MandateSessionResult> {
    // One-time mandates are clamped to 7 days upstream; recurring get horizons.
    const frequency = mandate.scope.recurrence === 'annual' ? 'yearly' : mandate.scope.recurrence;

    const payload: CreateSessionRequest = {
      user_id: mandate.requesterPhone.replace(/\D/g, '') || mandate.id,
      user_email: env.REQUESTER_EMAIL,
      total_amount: centsToAmountString(mandate.scope.perTransactionCapCents),
      currency: mandate.currency,
      purchase_context: this.purchaseContext(mandate, merchant),
      integration_type: 'full_checkout',
      external_order_ref: mandate.id,
      description: mandate.purpose.slice(0, 255),
      user_country_code_iso2: merchant.country,
      mandate_setup: {
        intent: 'mandate_setup',
        recurring_frequency: frequency,
        merchant_scope: 'listed',
        max_charges: mandate.scope.maxUses,
      },
      ...(callbackUrl?.startsWith('https://') ? { callback_url: callbackUrl } : {}),
    };

    if (!capabilities.prava) {
      return {
        sessionId: `sim_${mandate.id.replace('mdt_', '')}`,
        approvalUrl: '',
        authorizeOnly: true,
        degraded: true,
        degradedReason: 'PRAVA_API_KEY is not configured',
      };
    }

    try {
      const body = await this.http.post<CreateSessionResponse>(PRAVA_ROUTES.createSession, payload, {
        idempotencyKey: `session:${mandate.id}`,
      });
      if (!body?.session_id) throw new UpstreamError('prava', 'session response had no session_id', body);

      logger.info(
        { mandateId: mandate.id, sessionId: body.session_id, authorizeOnly: body.authorizeOnly },
        'prava mandate setup session created',
      );

      return {
        sessionId: body.session_id,
        approvalUrl: body.iframe_url,
        orderId: body.order_id,
        expiresAt: body.expires_at,
        authorizeOnly: body.authorizeOnly === true,
        degraded: false,
      };
    } catch (error) {
      const reason = describeHttpError(error);
      // TRIES_EXHAUSTED means the sandbox daily transaction budget is spent.
      // Say so plainly rather than letting it read as a generic outage.
      const friendly = /TRIES_EXHAUSTED|429/.test(reason)
        ? `${reason} — the sandbox test-transaction limit for this merchant is used up (30/day).`
        : reason;
      logger.error({ mandateId: mandate.id, err: friendly }, 'prava mandate setup failed');
      return {
        sessionId: `sim_${mandate.id.replace('mdt_', '')}`,
        approvalUrl: '',
        authorizeOnly: true,
        degraded: true,
        degradedReason: friendly,
      };
    }
  }

  /**
   * Find the Prava mandate created by a setup session.
   *
   * There is no create-mandate endpoint and the session response does not carry
   * a mandate id, so after approval we list mandates and match on the order we
   * submitted. Matching on `external_order_ref`/`order_id` rather than merchant
   * name matters once more than one mandate exists for the same vendor.
   */
  async findMandateForOrder(orderId?: string, externalRef?: string): Promise<PravaMandateSummary | null> {
    if (!capabilities.prava) return null;
    try {
      const body = await this.http.get<unknown>(PRAVA_ROUTES.listMandates);
      const mandates = normalizeMandateList(body);

      const match =
        mandates.find((m) => orderId && m.orderId === orderId) ??
        mandates.find((m) => externalRef && JSON.stringify(m.raw).includes(externalRef)) ??
        mandates.find((m) => m.status === 'active');

      if (match) logger.info({ pravaMandateId: match.id, status: match.status }, 'resolved prava mandate');
      else logger.warn({ orderId, externalRef, count: mandates.length }, 'no matching prava mandate found');
      return match ?? null;
    } catch (error) {
      logger.error({ err: describeHttpError(error) }, 'listing prava mandates failed');
      return null;
    }
  }

  // -- 2. Charge -----------------------------------------------------------

  /**
   * Mint single-use credentials against an approved mandate.
   *
   * `reference` is the idempotency key, so a retried checkout reuses the same
   * charge (`deduplicated: true`) instead of consuming a second one against the
   * mandate's `max_charges`.
   *
   * An over-cap amount comes back as `status: "failed"` with
   * `THRESHOLD_EXCEEDED` rather than an exception. That is the card network
   * enforcing the cap, which is the strongest possible demonstration that the
   * limit is real and not merely our policy engine's opinion.
   */
  async chargeMandate(
    pravaMandateId: string,
    mandate: Mandate,
    merchant: MerchantRecord = this.merchant,
  ): Promise<ChargeResult> {
    const payload: ChargeMandateRequest = {
      amount: centsToAmountString(mandate.amountCents),
      reference: `${mandate.id}:${mandate.scope.usesConsumed}`,
      purchase_context: this.purchaseContext(mandate, merchant),
    };

    if (!capabilities.prava) {
      return { ok: false, detail: 'simulated (no PRAVA_API_KEY)' };
    }

    try {
      const body = await this.http.post<ChargeMandateResponse>(
        PRAVA_ROUTES.chargeMandate(pravaMandateId),
        payload,
        { idempotencyKey: `charge:${mandate.id}:${mandate.scope.usesConsumed}` },
      );

      if (body.status === 'failed' || !body.credentials) {
        const reason = body.errorMessage ?? body.errorCode ?? 'charge failed without credentials';
        logger.warn({ mandateId: mandate.id, pravaMandateId, reason }, 'prava refused the charge');
        return {
          ok: false,
          pravaMandateId: body.mandateId ?? pravaMandateId,
          transactionId: body.transactionId,
          declineReason: reason,
          detail: reason,
        };
      }

      logger.info(
        {
          mandateId: mandate.id,
          pravaMandateId: body.mandateId,
          transactionId: body.transactionId,
          deduplicated: body.deduplicated === true,
        },
        'prava minted single-use credentials',
      );

      return {
        ok: true,
        pravaMandateId: body.mandateId ?? pravaMandateId,
        transactionId: body.transactionId,
        orderId: body.orderId,
        credentials: body.credentials,
        detail: body.deduplicated ? 'reused prior charge' : 'credentials minted',
      };
    } catch (error) {
      const detail = describeHttpError(error);
      logger.error({ mandateId: mandate.id, pravaMandateId, err: detail }, 'prava charge failed');
      return { ok: false, detail };
    }
  }

  // -- 3. Report -----------------------------------------------------------

  /**
   * Settle the charge with the card network.
   *
   * This is not optional bookkeeping. Until it is called, Prava holds a
   * transaction awaiting a result, the mandate's charge budget is not released,
   * and nothing reconciles. Prava's own guidance is explicit: always report,
   * and report DECLINED when credentials were used but checkout failed.
   *
   * The full request and response are returned so they can be stored as
   * evidence — for a sandbox run against a live merchant, the DECLINED receipt
   * IS the deliverable.
   */
  async reportCharge(
    pravaMandateId: string,
    transactionId: string,
    outcome: {
      approved: boolean;
      authorizationCode?: string;
      responseCode?: string;
      amountCents?: number;
    },
  ): Promise<ReportResult> {
    const request: ReportChargeRequest = {
      txn_status: outcome.approved ? 'APPROVED' : 'DECLINED',
      txn_type: 'PURCHASE',
      ...(outcome.authorizationCode ? { authorization_code: outcome.authorizationCode.slice(0, 128) } : {}),
      // The API caps response_code at 2 characters.
      ...(outcome.responseCode ? { response_code: outcome.responseCode.slice(0, 2) } : {}),
      ...(outcome.approved && outcome.amountCents !== undefined
        ? { amount_paid: centsToAmountString(outcome.amountCents) }
        : {}),
    };

    if (!capabilities.prava) {
      return { ok: false, detail: 'simulated (no PRAVA_API_KEY)', request };
    }

    try {
      const response = await this.http.post<ReportChargeResponse>(
        PRAVA_ROUTES.reportCharge(pravaMandateId, transactionId),
        request,
        { idempotencyKey: `report:${pravaMandateId}:${transactionId}` },
      );
      logger.info(
        {
          pravaMandateId,
          transactionId,
          txnStatus: request.txn_status,
          settlement: response.status,
          mandateStatus: response.mandateStatus,
          visa: response.visaConfirmation,
        },
        'prava charge settled',
      );
      return { ok: true, detail: `${response.status} / visa ${response.visaConfirmation ?? 'n/a'}`, response, request };
    } catch (error) {
      const detail = describeHttpError(error);
      logger.error({ pravaMandateId, transactionId, err: detail }, 'prava report failed');
      return { ok: false, detail, request };
    }
  }

  // -- Session settlement (hosted checkout, steps 3 and 4) -----------------

  /**
   * Step 3 of the REST checkout walkthrough: poll the session for its result.
   *
   * The value we need downstream is `txn_ref_id`, which identifies the line
   * item to settle in step 4. It lives at transactions[0].line_items[0], and
   * every field is treated as optional because the shape while the cardholder
   * is still on the hosted page ("pending") carries no transactions at all.
   *
   * The one-time card credentials also live here, and are deliberately NOT
   * returned or logged: this method exists to settle an order, not to widen
   * where card data can travel.
   */
  async getPaymentResult(sessionId: string): Promise<PaymentResultSummary> {
    if (!capabilities.prava) {
      return { ok: false, detail: 'simulated (no PRAVA_API_KEY)' };
    }

    try {
      const body = await this.http.get<PaymentResultResponse>(PRAVA_ROUTES.paymentResult(sessionId));
      const txnRefId = body?.transactions?.[0]?.line_items?.[0]?.txn_ref_id;
      logger.info(
        { sessionId, status: body?.status, orderId: body?.order_id, hasTxnRef: Boolean(txnRefId) },
        'prava payment result polled',
      );
      // Deliberately NOT returning the body: line_items carry `token` and
      // `dynamic_cvv`. Card data must not outlive the function that reads it,
      // so only the identifiers the caller needs are passed back.
      return {
        ok: true,
        detail: body?.status ?? 'unknown',
        status: body?.status,
        orderId: body?.order_id,
        txnRefId,
      };
    } catch (error) {
      const detail = describeHttpError(error);
      logger.warn({ sessionId, err: detail }, 'prava payment result poll failed');
      return { ok: false, detail };
    }
  }

  /**
   * Step 4: settle the session so the order stops showing as Pending.
   *
   * This is separate from reportCharge, and both are needed. reportCharge
   * settles the *mandate* transaction; this settles the *session*, which is the
   * record dashboard.prava.space displays. Reporting only the charge leaves the
   * dashboard order pending forever.
   *
   * If no txn_ref_id was captured we poll for one first rather than guessing,
   * because settling the wrong line item is worse than reporting late.
   */
  async reportSessionStatus(
    sessionId: string,
    outcome: { approved: boolean; txnRefId?: string },
  ): Promise<SessionReportResult> {
    if (!capabilities.prava) {
      return { ok: false, detail: 'simulated (no PRAVA_API_KEY)' };
    }

    let txnRefId = outcome.txnRefId;
    if (!txnRefId) {
      const polled = await this.getPaymentResult(sessionId);
      txnRefId = polled.txnRefId;
    }
    if (!txnRefId) {
      return { ok: false, detail: 'no txn_ref_id available to settle (session may not have been paid)' };
    }

    const request: ReportSessionStatusRequest = {
      txn_ref_id: txnRefId,
      txn_status: outcome.approved ? 'APPROVED' : 'DECLINED',
    };

    try {
      const response = await this.http.post<Record<string, unknown>>(
        PRAVA_ROUTES.reportSessionStatus(sessionId),
        request,
        { idempotencyKey: `session-report:${sessionId}:${txnRefId}` },
      );
      logger.info({ sessionId, txnRefId, txnStatus: request.txn_status }, 'prava session settled');
      return { ok: true, detail: `session reported ${request.txn_status}`, request, response };
    } catch (error) {
      const detail = describeHttpError(error);
      logger.error({ sessionId, txnRefId, err: detail }, 'prava session report failed');
      return { ok: false, detail, request };
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  /**
   * Withdraw the standing authorization.
   *
   * Cancelling the Prava mandate is what actually stops future charges;
   * revoking the session only closes the setup surface. We do both, and we do
   * not treat a failed upstream cancel as a local success.
   */
  /**
   * Close a session that will never be paid.
   *
   * report-status can only settle a session that has a payment attempt: the
   * cardholder must have completed Prava's hosted approval for a txn_ref_id to
   * exist. A session abandoned before that — approver declined, mandate
   * expired, checkout ran on the fallback card — has "Payment Attempts (0)"
   * and no line items, so the only way to stop its order dangling as Pending
   * on dashboard.prava.space is to revoke the session itself.
   */
  async closeUnpaidSession(sessionId: string, mandateId: string): Promise<{ ok: boolean; detail: string }> {
    if (!capabilities.prava) return { ok: false, detail: 'simulated (no PRAVA_API_KEY)' };
    if (!sessionId || sessionId.startsWith('sim_')) return { ok: false, detail: 'no live session to close' };
    try {
      await this.http.post(PRAVA_ROUTES.revokeSession(sessionId), {}, {
        idempotencyKey: `close-session:${mandateId}`,
        retryable: false,
      });
      logger.info({ sessionId, mandateId }, 'prava unpaid session closed');
      return { ok: true, detail: 'session revoked (order closed, no payment to settle)' };
    } catch (error) {
      const detail = describeHttpError(error);
      logger.warn({ sessionId, mandateId, err: detail }, 'prava session close failed');
      return { ok: false, detail };
    }
  }

  async revoke(mandate: Mandate): Promise<{ ok: boolean; detail: string }> {
    if (!capabilities.prava) return { ok: false, detail: 'simulated (no PRAVA_API_KEY)' };

    const notes: string[] = [];
    let ok = false;

    if (mandate.prava.pravaMandateId) {
      try {
        await this.http.post(
          PRAVA_ROUTES.cancelMandate(mandate.prava.pravaMandateId),
          { reason: 'revoked by approver' },
          { idempotencyKey: `cancel:${mandate.id}`, retryable: false },
        );
        notes.push('mandate cancelled');
        ok = true;
      } catch (error) {
        notes.push(`mandate cancel failed (${describeHttpError(error)})`);
      }
    }

    if (mandate.prava.sessionId && !mandate.prava.sessionId.startsWith('sim_')) {
      try {
        await this.http.post(PRAVA_ROUTES.revokeSession(mandate.prava.sessionId), {}, {
          idempotencyKey: `revoke-session:${mandate.id}`,
          retryable: false,
        });
        notes.push('session revoked');
        ok = true;
      } catch (error) {
        notes.push(`session revoke failed (${describeHttpError(error)})`);
      }
    }

    return { ok, detail: notes.join('; ') || 'nothing to revoke' };
  }

  async getMandateStatus(pravaMandateId: string): Promise<PravaMandateSummary | null> {
    if (!capabilities.prava) return null;
    try {
      const body = await this.http.get<unknown>(PRAVA_ROUTES.getMandate(pravaMandateId));
      const wrapped = normalizeMandateList(body);
      if (wrapped.length) return wrapped[0]!;
      const { normalizeMandate } = await import('./types.js');
      return normalizeMandate((body as any)?.mandate ?? body);
    } catch (error) {
      logger.warn({ pravaMandateId, err: describeHttpError(error) }, 'fetching prava mandate failed');
      return null;
    }
  }
}

let singleton: PravaClient | null = null;
export function pravaClient(): PravaClient {
  if (!singleton) singleton = new PravaClient();
  return singleton;
}
export function setPravaClient(client: PravaClient | null): void {
  singleton = client;
}
