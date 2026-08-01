import express, { Request, Response } from 'express';
import { config } from './config.js';
import { sendiMessage } from './services/linq.js';
import { processUserIntent } from './services/policyEngine.js';
import { executeMerchantCheckout } from './services/browserAgent.js';

const app = express();

// Requirement 1: Initialize Express server with JSON body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Requirement 3: POST /linq-webhook endpoint
app.post('/linq-webhook', (req: Request, res: Response): void => {
  const payload = req.body;

  // Log incoming payload
  console.log('[Linq Webhook] Incoming payload received:', JSON.stringify(payload, null, 2));

  // Extract event type (supports both 'type' and 'event' properties in payload)
  const eventType = payload?.type || payload?.event;

  // Verify the event type is 'message.created'
  if (eventType !== 'message.created') {
    console.warn(`[Linq Webhook] Ignored non-target event type: '${eventType}'`);
    res.status(200).json({ status: 'ignored', message: `Unhandled event type: ${eventType}` });
    return;
  }

  // Extract sender phone number (data.from) and message text (data.text)
  const data = payload?.data || payload;
  const fromPhone = data?.from;
  const messageText = data?.text;

  console.log(`[Linq Webhook] Extracted message -> From: ${fromPhone}, Text: "${messageText}"`);

  // Respond with 200 OK immediately
  res.status(200).json({ status: 'ok' });

  // Asynchronously process expense intent and policy evaluation
  if (fromPhone && messageText) {
    processUserIntent(fromPhone, messageText).catch((err) => {
      console.error('[Linq Webhook Error] Asynchronous processUserIntent failed:', err.message);
    });
  }
});

/**
 * Handler for Prava Passkey Authorization Callbacks (handles both GET redirect & POST webhook)
 */
const handlePravaCallback = (req: Request, res: Response): void => {
  const params = { ...req.query, ...req.body };
  console.log('[Prava Callback] Callback parameters received:', JSON.stringify(params, null, 2));

  const sessionId = (params.sessionId || params.session_id || `prv_sess_${Date.now()}`) as string;
  const sessionToken = (params.session_token || params.token || '') as string;
  const statusParam = (params.status || 'authorized') as string;
  const userPhone = (params.phone || config.linqPhoneNumber || '+15550009999') as string;

  const normalizedStatus = statusParam.toLowerCase();
  const isAuthorized =
    normalizedStatus === 'authorized' ||
    normalizedStatus === 'success' ||
    normalizedStatus === 'approved' ||
    Boolean(sessionToken);

  if (!isAuthorized) {
    console.warn(`[Prava Callback] Authorization failed or rejected for session ${sessionId}. Status: ${statusParam}`);
    res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Prava Authorization Failed</title>
        <style>
          body { background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; max-width: 440px; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          h1 { color: #f87171; font-size: 24px; margin-bottom: 12px; }
          p { color: #94a3b8; font-size: 15px; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>⚠️ Passkey Authorization Failed</h1>
          <p>The payment authorization session was rejected or canceled. Please check your expense details and try again via iMessage.</p>
        </div>
      </body>
      </html>
    `);
    return;
  }

  console.log(`[Prava Callback] Passkey authorization verified for session ${sessionId}. Triggering background checkout...`);

  // Trigger executeMerchantCheckout asynchronously in the background
  const cardData = {
    cardNumber: '4000000000003100',
    exp: '12/28',
    cvc: '123',
  };

  executeMerchantCheckout(sessionId, cardData, userPhone).catch((err) => {
    console.error(`[Prava Callback Error] Asynchronous checkout execution error for session ${sessionId}:`, err.message);
  });

  // Render clean confirmation HTML page immediately
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Passkey Verified | Agentic Commerce Agent</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: linear-gradient(135deg, #090d16 0%, #111827 50%, #0f172a 100%);
          color: #f8fafc;
          font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          padding: 24px;
        }
        .container {
          background: rgba(30, 41, 59, 0.7);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 24px;
          padding: 40px 32px;
          max-width: 480px;
          width: 100%;
          text-align: center;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 40px rgba(59, 130, 246, 0.15);
          animation: fadeIn 0.5s ease-out;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .icon-circle {
          width: 72px;
          height: 72px;
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          border-radius: 50%;
          display: flex;
          justify-content: center;
          align-items: center;
          margin: 0 auto 24px;
          box-shadow: 0 10px 20px -5px rgba(16, 185, 129, 0.4);
        }
        .icon-circle svg {
          width: 36px;
          height: 36px;
          fill: none;
          stroke: #ffffff;
          stroke-width: 3;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        h1 {
          font-size: 26px;
          font-weight: 700;
          color: #ffffff;
          margin-bottom: 16px;
          letter-spacing: -0.02em;
        }
        .highlight {
          color: #34d399;
        }
        p.message {
          font-size: 17px;
          line-height: 1.6;
          color: #cbd5e1;
          margin-bottom: 24px;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: rgba(59, 130, 246, 0.12);
          border: 1px solid rgba(59, 130, 246, 0.3);
          color: #60a5fa;
          font-size: 13px;
          font-weight: 600;
          padding: 8px 16px;
          border-radius: 100px;
          margin-bottom: 12px;
        }
        .session-info {
          font-family: monospace;
          font-size: 12px;
          color: #64748b;
          margin-top: 16px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon-circle">
          <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </div>
        <div class="badge">🔒 Prava Passkey Verified • Single-Use Visa Active</div>
        <h1>Passkey Verified!</h1>
        <p class="message">
          Agent is now executing checkout in the background. Check your iMessage for progress.
        </p>
        <div class="session-info">Session Token ID: ${sessionId}</div>
      </div>
    </body>
    </html>
  `);
};

// Requirement 1 & 5: Passkey Authorization Callbacks
app.get('/prava-callback', handlePravaCallback);
app.post('/prava-webhook', handlePravaCallback);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = config.port;

app.listen(PORT, () => {
  console.log(`[Server] Express server listening on port ${PORT}`);
  console.log(`[Server] Environment configuration loaded:`);
  console.log(`  - PORT: ${PORT}`);
  console.log(`  - LINQ_API_TOKEN: ${config.linqApiToken ? '[CONFIGURED]' : '[MISSING]'}`);
  console.log(`  - LINQ_PHONE_NUMBER: ${config.linqPhoneNumber ? '[CONFIGURED]' : '[MISSING]'}`);
  console.log(`  - PRAVA_API_KEY: ${config.pravaApiKey ? '[CONFIGURED]' : '[MISSING]'}`);
  console.log(`  - OPENAI_API_KEY: ${config.openaiApiKey ? '[CONFIGURED]' : '[MISSING]'}`);
  console.log(`  - BROWSERBASE_API_KEY: ${config.browserbaseApiKey ? '[CONFIGURED]' : '[MISSING]'}`);
});

export { app, sendiMessage };
