import { describe, expect, it } from 'vitest';
import { heuristicExtraction } from '../src/services/policy/extractor.js';

describe('offline extraction fallback', () => {
  it('pulls merchant, amount, seats and cadence out of a normal request', () => {
    const e = heuristicExtraction('We need a $45 monthly subscription to Figma for 2 designers');
    expect(e.merchant).toBe('Figma');
    expect(e.amountCents).toBe(4500);
    expect(e.recurrence).toBe('monthly');
    expect(e.seats).toBe(2);
    expect(e.category).toBe('software_subscription');
    expect(e.isPurchaseRequest).toBe(true);
  });

  it('handles a top-up phrased without a subscription', () => {
    const e = heuristicExtraction('Top up OpenAI credits by $20 please');
    expect(e.merchant).toBe('OpenAI');
    expect(e.amountCents).toBe(2000);
    expect(e.recurrence).toBe('one_time');
    expect(e.category).toBe('api_credits');
  });

  it('classifies a meal as a meal so policy can refuse it', () => {
    const e = heuristicExtraction('Team dinner at Olive, $80');
    expect(e.category).toBe('meals_entertainment');
    expect(e.amountCents).toBe(8000);
  });

  it('never reports enough confidence to spend money unattended', () => {
    // The fallback exists so the demo survives an API outage, not so it can
    // authorize purchases on regex alone.
    const strong = heuristicExtraction('Figma $45/mo for 2 designers');
    expect(strong.confidence).toBeLessThan(0.75);
  });

  it('asks a question instead of guessing when the amount is missing', () => {
    const e = heuristicExtraction('can we get Figma');
    expect(e.amountCents).toBe(0);
    expect(e.clarificationNeeded).toBeTruthy();
  });

  it('does not treat small talk as a purchase', () => {
    expect(heuristicExtraction('hey, morning!').isPurchaseRequest).toBe(false);
  });
});
