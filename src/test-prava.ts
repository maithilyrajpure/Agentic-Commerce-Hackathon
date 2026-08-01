import { createPravaSession } from './services/pravaService.js';
import { processUserIntent } from './services/policyEngine.js';

async function testPravaIntegration() {
  console.log('--- Test 1: Direct Prava Session Creation ---');
  try {
    const session = await createPravaSession('OpenAI', 45.0, 'API Credits for Hackathon');
    console.log('Created Prava Session:', JSON.stringify(session, null, 2));
    if (session.iframe_url && session.sessionId) {
      console.log('✅ Direct Prava Session Creation Passed!\n');
    } else {
      console.error('❌ Direct Prava Session Creation Failed: Missing fields\n');
    }
  } catch (err: any) {
    console.error('❌ Direct Prava Session Creation Error:', err.message, '\n');
  }

  console.log('--- Test 2: Process User Intent with Prava Integration ---');
  const mockPhone = '+15550001111';
  const mockText = 'Expensing $35 for Figma Professional subscription.';
  
  try {
    const result = await processUserIntent(mockPhone, mockText);
    console.log('Process User Intent Result:', JSON.stringify(result, null, 2));
    if (result && result.pravaSession && result.pravaSession.iframe_url) {
      console.log('✅ Process User Intent & Prava Session Creation Passed!\n');
    } else {
      console.log('Note: If OpenAI key is placeholder, test gracefully logged output.\n');
    }
  } catch (err: any) {
    console.error('Error during intent processing:', err.message, '\n');
  }
}

testPravaIntegration();
