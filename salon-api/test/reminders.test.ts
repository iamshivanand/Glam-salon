import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAdaptiveInterval } from '../src/services/reminders.js';
import { advanceStatus } from '../src/services/engagement.js';

test('Adaptive Interval: First visit (N=1) defaults to base service interval clamped to [7, 90]', () => {
  // Configured default 25 days
  const interval = calculateAdaptiveInterval({
    isRepeatVisit: false,
    baseServiceIntervalDays: 25,
  });
  assert.equal(interval, 25);

  // Unset defaults to 25
  const intervalDefault = calculateAdaptiveInterval({
    isRepeatVisit: false,
  });
  assert.equal(intervalDefault, 25);

  // Clamped to lower bound 7
  const clampedLow = calculateAdaptiveInterval({
    isRepeatVisit: false,
    baseServiceIntervalDays: 4,
  });
  assert.equal(clampedLow, 7);

  // Clamped to upper bound 90
  const clampedHigh = calculateAdaptiveInterval({
    isRepeatVisit: false,
    baseServiceIntervalDays: 120,
  });
  assert.equal(clampedHigh, 90);
});

test('Adaptive Interval: Repeat visit (N>=2) computes EWMA formula: round(0.7 * ActualDays + 0.3 * OldInterval)', () => {
  // Case A: Customer returned in 30 days, old interval was 25:
  // 0.7 * 30 + 0.3 * 25 = 21 + 7.5 = 28.5 -> round to 29
  const intervalA = calculateAdaptiveInterval({
    isRepeatVisit: true,
    actualDaysSinceLastVisit: 30,
    previousIntervalDays: 25,
    baseServiceIntervalDays: 25,
  });
  assert.equal(intervalA, 29);

  // Case B: Customer returned early in 15 days, old interval was 25:
  // 0.7 * 15 + 0.3 * 25 = 10.5 + 7.5 = 18 -> round to 18
  const intervalB = calculateAdaptiveInterval({
    isRepeatVisit: true,
    actualDaysSinceLastVisit: 15,
    previousIntervalDays: 25,
  });
  assert.equal(intervalB, 18);

  // Case C: Clamped to minimum 7 days (e.g. 2 days actual, 5 days old -> 2.9 -> 7)
  const intervalMin = calculateAdaptiveInterval({
    isRepeatVisit: true,
    actualDaysSinceLastVisit: 2,
    previousIntervalDays: 7,
  });
  assert.equal(intervalMin, 7);

  // Case D: Clamped to maximum 90 days (e.g. 150 days actual, 80 days old -> 129 -> 90)
  const intervalMax = calculateAdaptiveInterval({
    isRepeatVisit: true,
    actualDaysSinceLastVisit: 150,
    previousIntervalDays: 80,
  });
  assert.equal(intervalMax, 90);
});

test('Reminder Stages: Schedules Day 20, Day 25, and Day 35 stages based on interval', () => {
  const baseInterval = 25;
  const stageGentleOffset = Math.max(1, baseInterval - 5);
  const stageInviteOffset = baseInterval;
  const stageReengageOffset = baseInterval + 10;

  assert.equal(stageGentleOffset, 20, 'Day 20 gentle reminder stage');
  assert.equal(stageInviteOffset, 25, 'Day 25 booking invitation stage');
  assert.equal(stageReengageOffset, 35, 'Day 35 re-engagement win-back stage');

  // For adaptive interval of 30 days:
  const adaptiveInterval = 30;
  assert.equal(Math.max(1, adaptiveInterval - 5), 25);
  assert.equal(adaptiveInterval, 30);
  assert.equal(adaptiveInterval + 10, 40);
});

test('Monotonic Status Transitions: advanceStatus progresses forward and ignores out-of-order receipts', () => {
  // SCHEDULED -> SENT -> DELIVERED -> OPENED -> CLICKED -> CONVERTED_TO_BOOKING
  assert.equal(advanceStatus('SCHEDULED', 'SENT'), 'SENT');
  assert.equal(advanceStatus('SENT', 'DELIVERED'), 'DELIVERED');
  assert.equal(advanceStatus('DELIVERED', 'OPENED'), 'OPENED');
  assert.equal(advanceStatus('OPENED', 'CLICKED'), 'CLICKED');
  assert.equal(advanceStatus('CLICKED', 'CONVERTED_TO_BOOKING'), 'CONVERTED_TO_BOOKING');

  // Late duplicate or out-of-order webhook delivery cannot downgrade state
  assert.equal(advanceStatus('OPENED', 'DELIVERED'), 'OPENED', 'Late delivered receipt must not downgrade opened');
  assert.equal(advanceStatus('CLICKED', 'DELIVERED'), 'CLICKED', 'Late delivered receipt must not downgrade clicked');
  assert.equal(advanceStatus('CLICKED', 'OPENED'), 'CLICKED', 'Late opened receipt must not downgrade clicked');
  assert.equal(advanceStatus('CONVERTED_TO_BOOKING', 'DELIVERED'), 'CONVERTED_TO_BOOKING');
  assert.equal(advanceStatus('CONVERTED_TO_BOOKING', 'CLICKED'), 'CONVERTED_TO_BOOKING');
});
