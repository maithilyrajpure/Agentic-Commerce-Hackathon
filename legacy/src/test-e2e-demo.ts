import { processUserIntent } from './services/policyEngine.js';
import { reportPravaSessionStatus, executeMerchantCheckout } from './services/browserAgent.js';

async function runFullAgenticDemo() {
  console.log('\n================================================================================');
  console.log('🚀 AGENTIC COMMERCE HACKATHON - IMESSAGE EXPENSE AGENT E2E DEMO');
  console.log('================================================================================\n');

  const demoPhone = '+15559876543';
  const demoMessage = 'Expensing $45.00 for OpenAI API credits for Hackathon AI models';

  console.log(`[STAGE 1: LINQ WEBHOOK] Received iMessage from ${demoPhone}: "${demoMessage}"`);

  try {
    // Stage 2: OpenAI Policy Evaluation & Stage 3: Prava Session Creation
    console.log('[STAGE 2 & 3: POLICY EVALUATION & PRAVA SESSION]');
    const result = await processUserIntent(demoPhone, demoMessage);

    if (result && result.pravaSession) {
      console.log(`\n[STAGE 4: PASSKEY CALLBACK] Simulating User Passkey Verification for Session: ${result.pravaSession.sessionId}...`);
      console.log(`[PASSKEY URL]: ${result.pravaSession.iframe_url}`);
      
      // Stage 5: Browserbase Stagehand Execution & Prava Loop Closure
      console.log('\n[STAGE 5: BROWSERBASE STAGEHAND CHECKOUT & LOOP CLOSURE]');
      const cardData = {
        cardNumber: '4000000000003100',
        exp: '12/28',
        cvc: '123',
      };
      
      await executeMerchantCheckout(result.pravaSession.sessionId, cardData, demoPhone);
      
      console.log('\n✅ Full E2E Agentic Commerce Demo Completed Successfully!');
    } else {
      console.log('\n[DEMO NOTE] Intent evaluated or sandbox fallback triggered.');
    }
  } catch (error: any) {
    console.error('❌ E2E Demo Error:', error.message);
  }
}

runFullAgenticDemo();
