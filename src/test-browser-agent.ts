import { reportPravaSessionStatus, executeMerchantCheckout } from './services/browserAgent.js';

async function testBrowserAgent() {
  console.log('--- Test 1: Prava Session Status Reporting (Loop Closure) ---');
  const mockSessionId = `prv_sess_${Date.now()}`;
  try {
    const reportResult = await reportPravaSessionStatus(
      mockSessionId,
      'DECLINED_BY_MERCHANT_GATEWAY',
      'Gateway declined test card (Expected Sandbox Behavior)'
    );
    console.log('Status Report Result:', JSON.stringify(reportResult, null, 2));
    console.log('✅ Prava Status Reporting (Loop Closure) Test Passed!\n');
  } catch (err: any) {
    console.error('❌ Prava Status Reporting Error:', err.message, '\n');
  }

  console.log('--- Test 2: Full Merchant Checkout & Status Notification Flow ---');
  const mockPhone = '+15552223333';
  const cardData = {
    cardNumber: '4000000000003100',
    exp: '12/28',
    cvc: '123',
  };

  try {
    await executeMerchantCheckout(mockSessionId, cardData, mockPhone);
    console.log('✅ Full Merchant Checkout Automation Flow Test Executed Successfully!\n');
  } catch (err: any) {
    console.error('❌ Merchant Checkout Execution Error:', err.message, '\n');
  }
}

testBrowserAgent();
