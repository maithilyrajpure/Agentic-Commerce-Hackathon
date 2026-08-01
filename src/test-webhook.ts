import axios from 'axios';

async function testWebhook() {
  const PORT = process.env.PORT || 3100;
  const webhookUrl = `http://localhost:${PORT}/linq-webhook`;

  console.log(`[Test] Sending test payload to ${webhookUrl}...`);

  const mockPayload = {
    type: 'message.created',
    data: {
      id: 'msg_123456789',
      from: '+15551234567',
      to: '+15559876543',
      text: 'Expensing $45.00 for team lunch at Chipotle',
      createdAt: new Date().toISOString(),
    },
  };

  try {
    const response = await axios.post(webhookUrl, mockPayload, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log('[Test] Response status:', response.status);
    console.log('[Test] Response data:', response.data);
    if (response.status === 200 && response.data.status === 'ok') {
      console.log('✅ Linq webhook endpoint test passed!');
    } else {
      console.error('❌ Test failed: Unexpected response', response.data);
    }
  } catch (error: any) {
    console.error('❌ Test request failed:', error.message);
  }
}

testWebhook();
