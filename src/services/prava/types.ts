/**
 * Prava API types, matching the published REST reference.
 *
 * The earlier version of this file guessed at these shapes. The real API is
 * stricter in three ways that silently break an integration built on intuition,
 * so they are called out here:
 *
 *   1. Amounts are DECIMAL STRINGS ("49.99"), not numbers. We keep money as
 *      integer cents internally and stringify only at this boundary.
 *   2. `purchase_context` is an ARRAY with exactly one entry, nesting
 *      merchant_details and product_details.
 *   3. `user_id` and `user_email` are required on secret-key sessions;
 *      omitting them returns 400 VAL_2001.
 *
 * Docs: https://docs.prava.space/api-reference/overview
 */

export const PRAVA_ROUTES = {
  createSession: '/v1/sessions',
  revokeSession: (id: string) => `/v1/sessions/${encodeURIComponent(id)}/revoke`,
  getPaymentResult: (id: string) => `/v1/sessions/${encodeURIComponent(id)}/payment-result`,
  reportSessionStatus: (id: string) => `/v1/sessions/${encodeURIComponent(id)}/report-status`,


  listMandates: '/v1/mandates',
  getMandate: (id: string) => `/v1/mandates/${encodeURIComponent(id)}`,
  chargeMandate: (id: string) => `/v1/mandates/${encodeURIComponent(id)}/charge`,
  reportCharge: (id: string, txnId: string) =>
    `/v1/mandates/${encodeURIComponent(id)}/charges/${encodeURIComponent(txnId)}/report`,
  pauseMandate: (id: string) => `/v1/mandates/${encodeURIComponent(id)}/pause`,
  cancelMandate: (id: string) => `/v1/mandates/${encodeURIComponent(id)}/cancel`,
} as const;

export const PRAVA_BASE_URLS = {
  sandbox: 'https://sandbox.api.prava.space',
  production: 'https://api.prava.space',
} as const;

// --- Requests --------------------------------------------------------------

export interface MerchantDetails {
  name: string;
  /** Must be https: Prava forwards this to Visa. */
  url: string;
  country_code_iso2: string;
  category_code?: string;
  category?: string;
}

export interface ProductDetails {
  description: string;
  /** Decimal string. */
  unit_price: string;
  product_id?: string;
  quantity?: number;
}

export interface PurchaseContextEntry {
  merchant_details: MerchantDetails;
  product_details: ProductDetails[];
  effective_until_minutes?: number;
}

/**
 * Turns the session into an authorize-only mandate setup. The response carries
 * `authorizeOnly: true` and issues no credentials — exactly the separation this
 * product needs between "a human said yes" and "money moved".
 */
export interface MandateSetup {
  intent: 'mandate_setup' | 'checkout';
  recurring_frequency?: 'one_time' | 'weekly' | 'monthly' | 'yearly';
  /** `listed` locks to this merchant. Recurring frequencies force `listed`. */
  merchant_scope?: 'listed' | 'any';
  valid_until?: string;
  max_charges?: number;
}

export interface CreateSessionRequest {
  user_id: string;
  user_email: string;
  /** Decimal string. Becomes the authorized amount cap. */
  total_amount: string;
  currency: string;
  purchase_context: PurchaseContextEntry[];
  integration_type?: 'full_checkout' | 'embedding';
  /** Must be https. */
  callback_url?: string;
  mandate_setup?: MandateSetup;
  user_phone?: string;
  user_country_code_iso2?: string;
  external_order_ref?: string;
  description?: string;
}

export interface ChargeMandateRequest {
  /** Decimal string. Over-cap charges are declined by the card network. */
  amount: string;
  /** Idempotency key: same mandate + reference returns the original charge. */
  reference?: string;
  purchase_context?: PurchaseContextEntry[];
}

export interface ReportChargeRequest {
  txn_status: 'APPROVED' | 'DECLINED';
  txn_type: 'PURCHASE';
  authorization_code?: string;
  /** Max 2 characters. */
  response_code?: string;
  amount_paid?: string;
}

// --- Responses -------------------------------------------------------------

export interface CreateSessionResponse {
  session_id: string;
  session_token: string;
  iframe_url: string;
  order_id: string;
  expires_at: string;
  authorizeOnly?: boolean;
}

export interface PravaMandateSummary {
  id: string;
  status: 'pending' | 'active' | 'paused' | 'consumed' | 'cancelled' | 'expired' | string;
  orderId?: string;
  merchantName?: string;
  approvedAmount?: string;
  remainingAmount?: string;
  recurringFrequency?: string;
  raw: Record<string, unknown>;
}

/**
 * Credentials minted against an active mandate.
 *
 * `token` is a single-use network token, not the underlying PAN. It exists in
 * memory for one checkout and is never persisted or logged.
 */
export interface MandateCredentials {
  token: string;
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
}

export interface ChargeMandateResponse {
  mandateId: string;
  instructionId?: string;
  /** Pass to reportCharge. */
  transactionId: string;
  orderId?: string;
  status: 'awaiting_result' | 'failed' | string;
  fetchStatus?: 'SUCCESS' | 'FAILURE';
  credentials?: MandateCredentials;
  errorCode?: string;
  /** e.g. THRESHOLD_EXCEEDED on an over-cap decline. */
  errorMessage?: string;
  deduplicated?: boolean;
}

export interface ReportChargeResponse {
  mandateId: string;
  transactionId: string;
  orderId?: string;
  status: 'completed' | 'failed' | string;
  /** The mandate's status after settlement. */
  mandateStatus?: string;
  visaConfirmation?: 'SUCCESS' | 'FAILURE';
}

export interface PravaApiError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// --- Helpers ---------------------------------------------------------------

/** Integer cents to the decimal string Prava expects. Never a float. */
export function centsToAmountString(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** MM/YY for a checkout form, from Prava's separate month and year fields. */
export function credentialExpiry(c: MandateCredentials): string {
  return `${String(c.expiryMonth).padStart(2, '0')}/${String(c.expiryYear).slice(-2)}`;
}

/**
 * Prava sanitizes merchant names to a Visa-safe character set (their example:
 * `H&M` becomes `HM`). Doing it here means the name we send matches the name we
 * display, instead of diverging silently after the API rewrites it.
 */
export function visaSafeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 .\-']/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Merchant';
}

export function isPravaError(body: unknown): body is PravaApiError {
  return Boolean(
    body && typeof body === 'object' && 'error' in body && typeof (body as PravaApiError).error?.code === 'string',
  );
}

/** Normalize a mandate record from list/get, which may be wrapped. */
export function normalizeMandate(raw: unknown): PravaMandateSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  const id = o.id ?? o.mandate_id ?? o.mandateId;
  if (typeof id !== 'string') return null;
  return {
    id,
    status: String(o.status ?? o.mandate_status ?? o.mandateStatus ?? 'unknown'),
    orderId: o.order_id ?? o.orderId,
    merchantName: o.merchant_name ?? o.merchantName ?? o.merchant?.name,
    approvedAmount: o.approved_amount ?? o.approvedAmount,
    remainingAmount: o.remaining_amount ?? o.remainingAmount,
    recurringFrequency: o.recurring_frequency ?? o.recurringFrequency,
    raw: o,
  };
}

/** Pull a mandate array out of whatever envelope the list endpoint uses. */
export function normalizeMandateList(body: unknown): PravaMandateSummary[] {
  if (!body) return [];
  const candidates: unknown[] = Array.isArray(body)
    ? body
    : ((body as Record<string, any>).mandates ??
       (body as Record<string, any>).data ??
       (body as Record<string, any>).items ??
       []);
  return (Array.isArray(candidates) ? candidates : [])
    .map(normalizeMandate)
    .filter((m): m is PravaMandateSummary => m !== null);
}
