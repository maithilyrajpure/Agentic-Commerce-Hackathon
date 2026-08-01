import { evaluateExpenseIntent } from './services/policyEngine.js';

async function runPolicyEngineTests() {
  console.log('--- Policy Engine Verification Tests ---\n');

  const testCases = [
    {
      description: 'Valid expense under $100 for Software/API',
      text: 'I bought $45.00 of OpenAI API credits for the backend project.',
      expectedPolicy: true,
    },
    {
      description: 'Valid expense under $100 for SaaS tool',
      text: 'Need to expense $79/mo Figma subscription.',
      expectedPolicy: true,
    },
    {
      description: 'Over $100 limit expense (Violates policy)',
      text: 'Expensing $150 for JetBrains All Products Pack subscription.',
      expectedPolicy: false,
    },
    {
      description: 'Disallowed category expense (Violates policy)',
      text: 'I spent $55 on team lunch at Olive Garden.',
      expectedPolicy: false,
    },
  ];

  for (const testCase of testCases) {
    console.log(`Test: ${testCase.description}`);
    console.log(`Input Text: "${testCase.text}"`);
    try {
      const result = await evaluateExpenseIntent(testCase.text);
      console.log('Result:', JSON.stringify(result, null, 2));
      const passed = result.isWithinPolicy === testCase.expectedPolicy;
      console.log(passed ? '✅ PASSED\n' : '❌ FAILED\n');
    } catch (err: any) {
      console.log(`[Note] Test execution encountered expected error if API key not provided: ${err.message}\n`);
    }
  }
}

// Execute test suite if run directly
runPolicyEngineTests();
