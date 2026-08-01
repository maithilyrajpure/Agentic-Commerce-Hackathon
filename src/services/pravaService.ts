import axios from 'axios';
import { config } from '../config.js';
import { sendiMessage } from './linq.js';

export interface PravaPurchaseContext {
  purpose: string;
  spending_limit: number;
  max_usage_count: number;
}

export interface PravaSessionPayload {
  total_amount: number;
  currency: string;
  merchant_name: string;
  integration_type: string;
  purchase_context: PravaPurchaseContext;
}

export interface PravaSessionResponse {
  sessionId: string;
  iframe_url: string;
  merchant_name?: string;
  total_amount?: number;
  status?: string;
  created_at?: string;
  [key: string]: any;
}

/**
 * Creates a merchant-scoped single-use payment session token via Prava API.
 * If Prava API throws an error, informs the employee on iMessage.
 */
export async function createPravaSession(
  merchantName: string,
  amount: number,
  purpose: string,
  userPhone?: string
): Promise<PravaSessionResponse> {
  const url = 'https://api.prava.space/v1/sessions';
  const payload: PravaSessionPayload = {
    total_amount: amount,
    currency: 'USD',
    merchant_name: merchantName,
    integration_type: 'full_checkout',
    purchase_context: {
      purpose: purpose,
      spending_limit: amount,
      max_usage_count: 1,
    },
  };

  console.log(`[Prava API] Creating single-use payment session for merchant "${merchantName}" ($${amount.toFixed(2)})...`);

  const apiKey = config.pravaApiKey;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
      timeout: 10000,
    });

    const data = response.data;
    console.log(`[Prava API] Session created successfully. Status: ${response.status}`);

    const sessionId = data.sessionId || data.session_id || data.id || `prv_sess_${Date.now()}`;
    const iframeUrl = data.iframe_url || data.url || data.authorization_url || `https://auth.prava.space/session/${sessionId}`;

    return {
      sessionId,
      iframe_url: iframeUrl,
      merchant_name: merchantName,
      total_amount: amount,
      ...data,
    };
  } catch (error: any) {
    const errorDetails = error.response?.data?.message || error.message;
    console.warn(`[Prava API Error] Call to ${url} failed:`, errorDetails);

    // Inform employee on iMessage if Prava API fails unexpectedly
    if (userPhone) {
      const errorMessage = `⚠️ Prava Payment Session Notice\n\nCould not initialize Prava authorization session: ${errorDetails}\n\nFallback sandbox authorization URL generated.`;
      sendiMessage(userPhone, errorMessage).catch(() => {});
    }

    // Sandbox / Mock fallback if live Prava service is unavailable or key not configured yet
    const fallbackSessionId = `prv_sess_${Math.random().toString(36).substring(2, 10)}`;
    const fallbackIframeUrl = `https://auth.prava.space/session/${fallbackSessionId}?merchant=${encodeURIComponent(merchantName)}&limit=${amount}`;
    
    console.log(`[Prava API] Generated sandbox fallback session: ${fallbackSessionId}`);
    return {
      sessionId: fallbackSessionId,
      iframe_url: fallbackIframeUrl,
      merchant_name: merchantName,
      total_amount: amount,
      status: 'created_sandbox',
    };
  }
}
