import OpenAI from 'openai';
import { config } from '../config.js';
import { sendiMessage } from './linq.js';
import { createPravaSession, PravaSessionResponse } from './pravaService.js';
import { executeMerchantCheckout } from './browserAgent.js';

export interface ExpenseIntent {
  merchant: string;
  amount: number;
  purpose: string;
  isWithinPolicy: boolean;
  policyReason: string;
}

export interface ProcessIntentResult {
  intent: ExpenseIntent;
  pravaSession?: PravaSessionResponse;
}

const openai = new OpenAI({
  apiKey: config.openaiApiKey || 'placeholder_key',
});

const SYSTEM_PROMPT = `You are an automated Corporate Expense Policy Evaluator.
Your job is to parse raw user text into structured JSON and evaluate whether the requested transaction complies with corporate expense policy rules.

Corporate Spend Policy Rules:
1. Maximum single transaction amount allowed: $100.00 USD. Any amount strictly greater than $100 (e.g. $100.01+) is a violation.
2. Allowed expense categories: Software, SaaS, API Credits, Dev Tools, Office Supplies.
3. Disallowed categories: Food, dining, entertainment, travel, gift cards, personal items, hardware/electronics (unless minor office supplies), or anything outside allowed categories.
4. If the transaction violates amount limit or category rules:
   - Set "isWithinPolicy" to false.
   - Provide a clear, professional explanation in "policyReason" detailing why the request was rejected.
5. If the transaction satisfies all policy rules:
   - Set "isWithinPolicy" to true.
   - Set "policyReason" to "Request complies with corporate expense policy."

Output Format Requirement:
You MUST output a valid JSON object matching this schema exactly:
{
  "merchant": "string",
  "amount": number,
  "purpose": "string",
  "isWithinPolicy": boolean,
  "policyReason": "string"
}`;

/**
 * Parses user text using OpenAI gpt-4o with structured JSON mode and evaluates corporate spend policy.
 */
export async function evaluateExpenseIntent(userText: string): Promise<ExpenseIntent> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response content received from OpenAI');
    }

    const parsed: ExpenseIntent = JSON.parse(content);
    
    // Fallback runtime validation of parsed fields
    parsed.merchant = parsed.merchant || 'Unknown Merchant';
    parsed.amount = typeof parsed.amount === 'number' ? parsed.amount : parseFloat(parsed.amount as any) || 0;
    parsed.purpose = parsed.purpose || userText;
    parsed.isWithinPolicy = Boolean(parsed.isWithinPolicy);
    parsed.policyReason = parsed.policyReason || (parsed.isWithinPolicy ? 'Compliant' : 'Non-compliant');

    // Hard safeguard for $100 limit in case model misinterprets
    if (parsed.amount > 100 && parsed.isWithinPolicy) {
      parsed.isWithinPolicy = false;
      parsed.policyReason = `Amount ($${parsed.amount.toFixed(2)}) exceeds maximum single transaction limit of $100.00 USD.`;
    }

    return parsed;
  } catch (error: any) {
    console.error('[Policy Engine Error] Failed to evaluate intent with OpenAI:', error.message);
    throw error;
  }
}

/**
 * Process user intent:
 * 1. Evaluates text under policy engine.
 * 2. If out of policy: sends rejection message via sendiMessage and returns null.
 * 3. If valid: calls createPravaSession, sends authorization iMessage with iframe_url & Visa guardrails,
 *    triggers Browserbase automated merchant checkout, reports status to Prava API, and sends execution receipt.
 */
export async function processUserIntent(phone: string, text: string): Promise<ProcessIntentResult | null> {
  console.log(`[Policy Engine] Evaluating message from ${phone}: "${text}"`);
  
  try {
    const intent = await evaluateExpenseIntent(text);
    console.log(`[Policy Engine] Evaluation result:`, intent);

    if (!intent.isWithinPolicy) {
      const rejectionMessage = `❌ Expense Request Rejected\n\nMerchant: ${intent.merchant}\nAmount: $${intent.amount.toFixed(2)}\nReason: ${intent.policyReason}`;
      
      console.log(`[Policy Engine] Request out of policy. Sending rejection message to ${phone}...`);
      await sendiMessage(phone, rejectionMessage);
      return null;
    }

    console.log(`[Policy Engine] Request approved under policy for ${phone}. Creating Prava session...`);
    
    // Create Prava session token
    const pravaSession = await createPravaSession(intent.merchant, intent.amount, intent.purpose, phone);

    // Format iMessage back to employee
    const approvalMessage = [
      `✅ Expense Request Approved!`,
      ``,
      `Merchant: ${intent.merchant}`,
      `Purpose: ${intent.purpose}`,
      `Amount Approved: $${intent.amount.toFixed(2)} USD`,
      ``,
      `🔒 Active Visa Guardrail Warning:`,
      `Single-use Visa authorization active. Spending limit capped strictly at $${intent.amount.toFixed(2)} USD (Max Usage: 1).`,
      ``,
      `🔑 Authorize with Prava Passkey:`,
      `${pravaSession.iframe_url}`,
    ].join('\n');

    console.log(`[Policy Engine] Sending Prava Passkey authorization link to ${phone}...`);
    await sendiMessage(phone, approvalMessage);

    // Asynchronously launch automated Stagehand browser checkout & Prava status report
    const cardData = {
      cardNumber: '4000000000003100',
      exp: '12/28',
      cvc: '123',
    };
    executeMerchantCheckout(pravaSession.sessionId, cardData, phone).catch((err) => {
      console.error('[Policy Engine Error] Automated checkout failed:', err.message);
    });

    return {
      intent,
      pravaSession,
    };
  } catch (error: any) {
    console.error(`[Policy Engine Error] Error processing user intent for ${phone}:`, error.message);
    return null;
  }
}
