/**
 * Merchant registry and checkout mode.
 *
 * Two facts from the Prava team shape this file, and they are worth stating
 * plainly because they determine what a demo can honestly claim:
 *
 *   1. Prava does not host a public sandbox merchant for SDK/API integrations.
 *   2. A Prava sandbox credential presented to a live merchant's payment
 *      gateway WILL be declined. It cannot create a real or mock order.
 *
 * So there are exactly two defensible ways to close the loop, and this project
 * implements both rather than pretending the first one succeeds:
 *
 *   LIVE_DECLINE — drive a real merchant with sandbox credentials, capture the
 *                  gateway's decline, and report it to Prava as DECLINED. The
 *                  Prava team confirmed this counts as a successful sandbox
 *                  transaction provided the decline is shown, not hidden.
 *                  This is the default.
 *
 *   DEV_STORE    — drive your own Shopify development store with test payments
 *                  enabled, where a card can actually authorize. This is the
 *                  only way to exercise the APPROVED branch end to end.
 *
 * The mode is explicit configuration, surfaced on the dashboard and in the
 * receipt, so nobody can mistake one for the other.
 */

export type CheckoutMode = 'live_decline' | 'dev_store';

export interface MerchantRecord {
  /** Stable key used in config and mandates. */
  id: string;
  /** Display name. Prava sanitizes this to a Visa-safe character set. */
  name: string;
  /** Storefront origin. Must be https: Prava forwards it to Visa. */
  url: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  category: string;
  /** UCP / MCP endpoint from the Prava merchant list, where published. */
  ucpEndpoint?: string;
  /**
   * What a sandbox credential does here.
   *  - `declines`  live gateway, sandbox card is refused (expected)
   *  - `authorizes` your own dev store with test payments on
   */
  sandboxBehaviour: 'declines' | 'authorizes';
  notes?: string;
}

/**
 * Drawn from the hackathon merchant list. This is a discovery aid, not a
 * compatibility guarantee — the handbook is explicit that not every listed
 * merchant has been tested end to end, so validate your choice early and keep
 * a fallback.
 */
export const MERCHANTS: readonly MerchantRecord[] = [
  {
    id: 'littlebox_india',
    name: 'Littlebox India',
    url: 'https://littleboxindia.com',
    country: 'IN',
    category: 'Apparel/Clothing',
    ucpEndpoint: 'https://lbindia.myshopify.com/api/ucp/mcp',
    sandboxBehaviour: 'declines',
    notes: 'On the Prava merchant list with a published UCP endpoint. Live Shopify gateway: sandbox cards decline.',
  },
  {
    id: 'headphone_zone',
    name: 'Headphone Zone',
    url: 'https://headphonezone.in',
    country: 'IN',
    category: 'Consumer Electronics/Audio',
    ucpEndpoint: 'https://headphone-zone.myshopify.com/api/ucp/mcp',
    sandboxBehaviour: 'declines',
    notes: 'Good fallback: clear product pages and a conventional Shopify checkout.',
  },
  {
    id: 'boat_lifestyle',
    name: 'boAt Lifestyle',
    url: 'https://boat-lifestyle.com',
    country: 'IN',
    category: 'Consumer Electronics/Audio',
    ucpEndpoint: 'https://boatlifestylein.myshopify.com/api/ucp/mcp',
    sandboxBehaviour: 'declines',
  },
  {
    id: 'mokobara',
    name: 'Mokobara',
    url: 'https://mokobara.com',
    country: 'IN',
    category: 'Luggage & Travel Accessories',
    ucpEndpoint: 'https://mokobara.myshopify.com/api/ucp/mcp',
    sandboxBehaviour: 'declines',
  },
  {
    id: 'deodap',
    name: 'DeoDap',
    url: 'https://deodap.in',
    country: 'IN',
    category: 'Business & Industrial',
    ucpEndpoint: 'https://a5aec8.myshopify.com/api/ucp/mcp',
    sandboxBehaviour: 'declines',
    notes: 'B2B supplies catalogue, so line items read plausibly as office spend.',
  },
  {
    id: 'oswaal_books',
    name: 'Oswaal Books',
    url: 'https://oswaalbooks.com',
    country: 'IN',
    category: 'Education',
    ucpEndpoint: 'https://oswaalbooks.myshopify.com/api/ucp/mcp',
    sandboxBehaviour: 'declines',
  },
];

export function findMerchant(idOrName: string): MerchantRecord | undefined {
  const needle = idOrName.trim().toLowerCase();
  return MERCHANTS.find(
    (m) => m.id === needle || m.name.toLowerCase() === needle || m.url.toLowerCase().includes(needle),
  );
}

/**
 * Build the merchant record actually used for a checkout.
 *
 * In dev_store mode the storefront is yours, so it comes from env rather than
 * the registry. Prava requires an https URL because the value is forwarded to
 * Visa, so we validate that here rather than letting the API reject it later.
 */
export function resolveMerchant(params: {
  mode: CheckoutMode;
  merchantId: string;
  devStoreUrl: string;
  devStoreName: string;
}): MerchantRecord {
  if (params.mode === 'dev_store') {
    const url = params.devStoreUrl.trim();
    if (!url.startsWith('https://')) {
      throw new Error(
        'DEV_STORE_URL must be an https URL. Prava forwards the merchant URL to Visa and rejects anything else.',
      );
    }
    return {
      id: 'dev_store',
      name: params.devStoreName,
      url,
      country: 'IN',
      category: 'Developer test store',
      sandboxBehaviour: 'authorizes',
      notes: 'Your own Shopify development store with test payments enabled.',
    };
  }

  const found = findMerchant(params.merchantId);
  if (!found) {
    const known = MERCHANTS.map((m) => m.id).join(', ');
    throw new Error(`Unknown MERCHANT_ID "${params.merchantId}". Known merchants: ${known}`);
  }
  return found;
}

/** One line for the dashboard and the receipt, so the mode is never ambiguous. */
export function describeMode(mode: CheckoutMode, merchant: MerchantRecord): string {
  return mode === 'dev_store'
    ? `Test payments at ${merchant.name} (your development store). Charges can authorize.`
    : `Live gateway at ${merchant.name}. Sandbox credentials are expected to decline; the decline is the evidence.`;
}
