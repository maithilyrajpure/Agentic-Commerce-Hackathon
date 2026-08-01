/**
 * Scripted demo. Runs the five scenarios that matter, in order, against a live
 * server, printing what a judge needs to see:
 *
 *   1. refused outright         — category the agent may not buy
 *   2. bought unattended        — under the auto-approve limit
 *   3. escalated to a human     — over the limit, recurring
 *   4. approved by passkey      — the mandate completes
 *   5. duplicate caught         — a second subscription to the same vendor
 *
 * Usage:  npm run dev            (terminal 1)
 *         npm run demo           (terminal 2)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { mintGrant } from '../src/lib/crypto.js';
import { formatUsd } from '../src/domain/money.js';

const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3100';
const REQUESTER = process.env.DEMO_PHONE ?? '+15550100200';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const STATE_COLOUR: Record<string, (s: string) => string> = {
  REJECTED: c.red,
  REVOKED: c.red,
  DECLINED: c.red,
  FAILED: c.red,
  PENDING_APPROVAL: c.amber,
  AUTHORIZED: c.amber,
  PROVISIONED: c.amber,
  EXECUTING: c.amber,
  COMPLETED: c.green,
  EXPIRED: c.dim,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

function heading(n: number, title: string, subtitle: string): void {
  console.log(`\n${c.bold(`${n}. ${title}`)}`);
  console.log(c.dim(`   ${subtitle}`));
  console.log(c.dim(`   ${'─'.repeat(72)}`));
}

interface SimResult {
  kind: string;
  reply?: string;
  mandate?: {
    id: string;
    state: string;
    merchant: string;
    amountCents: number;
    policyDecision?: string;
    policyReasons: string[];
  };
}

async function request(text: string): Promise<SimResult> {
  console.log(`   ${c.cyan('→')} "${text}"`);
  const result = await api<SimResult>('/api/simulate/message', {
    method: 'POST',
    body: JSON.stringify({ from: REQUESTER, text }),
  });
  await sleep(400);

  if (!result.mandate) {
    console.log(`   ${c.dim('←')} ${result.kind}: ${result.reply?.split('\n')[0] ?? ''}`);
    return result;
  }

  const paint = STATE_COLOUR[result.mandate.state] ?? c.dim;
  console.log(
    `   ${c.dim('←')} ${paint(result.mandate.state.padEnd(17))} ${formatUsd(result.mandate.amountCents)} at ${result.mandate.merchant}`,
  );
  for (const reason of result.mandate.policyReasons) console.log(`     ${c.dim('·')} ${reason}`);
  return result;
}

async function stateOf(id: string): Promise<string> {
  const { mandate } = await api<{ mandate: { state: string } }>(`/api/mandates/${id}`);
  return mandate.state;
}

async function main(): Promise<void> {
  console.log(c.bold('\n  Visa Agentic Mandate Manager · scripted demo'));
  console.log(c.dim(`  ${BASE}\n`));

  try {
    const ready = await api<{ status: string; degraded: string[]; checkoutMode: string; merchant: string }>('/ready');
    console.log(
      `  server ${ready.status === 'ok' ? c.green('ready') : c.amber('degraded')}` +
        (ready.degraded.length ? c.dim(`  (unconfigured: ${ready.degraded.join(', ')})`) : ''),
    );
    console.log(c.dim(`  checkout mode: ${ready.checkoutMode} at ${ready.merchant}`));
    if (ready.checkoutMode === 'live_decline') {
      console.log(c.dim('  a live gateway will decline the sandbox credential — that decline is the evidence'));
    }
  } catch {
    console.error(c.red(`\n  Cannot reach ${BASE}. Start the server with \`npm run dev\` first.\n`));
    process.exit(1);
  }

  // -- 1 -------------------------------------------------------------------
  heading(1, 'Refused outright', 'A category the purchasing agent has no authority over.');
  await request('Team dinner at Olive Bistro, $80');

  // -- 2 -------------------------------------------------------------------
  heading(2, 'Bought unattended', 'Under the auto-approve limit, so no human is interrupted.');
  const topup = await request('Top up our OpenAI credits by $20');
  if (topup.mandate) {
    await sleep(2500);
    console.log(`   ${c.dim('·')} settled as ${STATE_COLOUR[await stateOf(topup.mandate.id)]?.(await stateOf(topup.mandate.id)) ?? ''}`);
  }

  // -- 3 -------------------------------------------------------------------
  heading(3, 'Escalated to a human', 'Over the limit and recurring, so it waits for a passkey.');
  const figma = await request('We need a $45 monthly subscription to Figma for 2 designers');
  if (!figma.mandate) throw new Error('expected a mandate');

  console.log(`\n   ${c.dim('The approval link sent to the approver:')}`);
  const token = mintGrant(figma.mandate.id, 'approve', 30);
  console.log(`   ${c.cyan(`${BASE}/authorize/${token}`)}`);
  console.log(
    c.dim('   Open it in a browser to approve by hand, or wait — this script approves it in 6 seconds.'),
  );
  await sleep(6000);

  // -- 4 -------------------------------------------------------------------
  heading(4, 'Approved by passkey', 'Only now is a card issued and a merchant contacted.');
  console.log(`   ${c.dim('state before approval:')} ${await stateOf(figma.mandate.id)}`);
  await api(`/authorize/${token}`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
  await sleep(1200);
  console.log(`   ${c.dim('state after approval: ')} ${await stateOf(figma.mandate.id)}`);
  console.log(c.dim('   Watch the server terminal for the checkout banner.'));
  await sleep(8000);
  const settled = await stateOf(figma.mandate.id);
  console.log(`   ${c.dim('final:')} ${STATE_COLOUR[settled]?.(settled) ?? settled}`);

  // -- 5 -------------------------------------------------------------------
  heading(5, 'Duplicate caught', 'The rogue-subscription problem this product exists to solve.');
  await request('Can we add another Figma subscription, $45 a month');

  console.log(`\n  ${c.bold('Ledger:')} ${BASE}/dashboard`);
  console.log(c.dim('  Every decision above, with its guardrail band and audit trail.\n'));
}

main().catch((error) => {
  console.error(c.red(`\n  Demo failed: ${(error as Error).message}\n`));
  process.exit(1);
});
