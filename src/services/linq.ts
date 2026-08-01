import axios from 'axios';
import { config } from '../config.js';

export interface LinqMessagePayload {
  to: string;
  from?: string;
  text: string;
  [key: string]: any;
}

/**
 * Sends an iMessage via Linq REST API with automatic retry and exponential backoff.
 */
export async function sendiMessage(toPhone: string, text: string, maxRetries: number = 3): Promise<any> {
  const url = 'https://api.linqapp.com/v1/messages';
  const payload: LinqMessagePayload = {
    to: toPhone,
    text: text,
  };

  if (config.linqPhoneNumber) {
    payload.from = config.linqPhoneNumber;
  }

  let attempt = 0;
  let lastError: any = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.linqApiToken}`,
        },
        timeout: 10000,
      });
      console.log(`[Linq API] Message sent successfully to ${toPhone} (Attempt ${attempt}/${maxRetries}). Status: ${response.status}`);
      return response.data;
    } catch (error: any) {
      lastError = error;
      console.warn(
        `[Linq API Error] Failed to send iMessage to ${toPhone} (Attempt ${attempt}/${maxRetries}):`,
        error.response?.data || error.message
      );

      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 500;
        console.log(`[Linq API Retry] Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error(`[Linq API Error] All ${maxRetries} retry attempts failed for ${toPhone}. Fallback logging active.`);
  return { status: 'failed_after_retries', error: lastError?.message };
}
