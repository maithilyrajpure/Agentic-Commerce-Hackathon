import axios from 'axios';

async function testPravaCallback() {
  const PORT = process.env.PORT || 3100;
  const callbackUrl = `http://localhost:${PORT}/prava-callback`;

  console.log(`[Test] Sending test GET request to ${callbackUrl}...`);

  try {
    const response = await axios.get(callbackUrl, {
      params: {
        sessionId: 'prv_sess_test_9999',
        status: 'authorized',
        session_token: 'tok_passkey_verified_123',
      },
    });

    console.log('[Test] Response status:', response.status);
    console.log('[Test] Content-Type:', response.headers['content-type']);
    const html = response.data;
    
    if (html.includes('Passkey Verified!') && html.includes('Agent is now executing checkout in the background')) {
      console.log('✅ Prava Passkey Callback GET Endpoint Test Passed!\n');
    } else {
      console.error('❌ Test failed: HTML did not contain expected text', html);
    }
  } catch (error: any) {
    console.error('❌ Callback test request failed:', error.message);
  }
}

testPravaCallback();
