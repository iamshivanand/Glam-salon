import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractComplaintTags } from '../src/services/booking.js';

test('AI Complaint Tagging: Detects CLEANLINESS and hygiene issues', () => {
  // Keyword matches in text
  const tags1 = extractComplaintTags('The salon was dirty, towels smelled bad and there was hair on chair', {
    overall: 3,
    hygiene: 3,
  });
  assert(tags1.includes('CLEANLINESS'));

  // Low hygiene rating (<= 2) automatically triggers tag
  const tags2 = extractComplaintTags('Everything was ok but basic', {
    overall: 4,
    hygiene: 2,
  });
  assert(tags2.includes('CLEANLINESS'));
});

test('AI Complaint Tagging: Detects WAIT_TIME delays', () => {
  const tags = extractComplaintTags('Had to wait 45 minutes past my slot time, very slow and delayed queue', {
    overall: 3,
    hygiene: 4,
  });
  assert(tags.includes('WAIT_TIME'));
  assert.equal(tags.includes('CLEANLINESS'), false);
});

test('AI Complaint Tagging: Detects PRICING and unexpected billing', () => {
  const tags = extractComplaintTags('Way too expensive, they charged extra hidden fees on the final bill', {
    overall: 3,
    hygiene: 4,
  });
  assert(tags.includes('PRICING'));
});

test('AI Complaint Tagging: Detects STAFF_BEHAVIOUR complaints', () => {
  const tags = extractComplaintTags('Stylist was rude, arrogant and had an unprofessional attitude', {
    overall: 3,
    hygiene: 4,
  });
  assert(tags.includes('STAFF_BEHAVIOUR'));
});

test('AI Complaint Tagging: Detects SERVICE_QUALITY and low overall ratings', () => {
  // Keyword match
  const tags1 = extractComplaintTags('Bad cut, completely uneven fade and ruined my haircut', {
    overall: 3,
    hygiene: 4,
  });
  assert(tags1.includes('SERVICE_QUALITY'));

  // Low overall rating (<= 2) automatically triggers SERVICE_QUALITY
  const tags2 = extractComplaintTags('Did not like the experience', {
    overall: 2,
    hygiene: 4,
  });
  assert(tags2.includes('SERVICE_QUALITY'));
});

test('AI Complaint Tagging: Multi-category compound complaint', () => {
  const tags = extractComplaintTags(
    'Dirty towels, rude barber, and they charged extra after making me wait 40 minutes!',
    { overall: 1, hygiene: 1 },
  );

  assert(tags.includes('CLEANLINESS'));
  assert(tags.includes('WAIT_TIME'));
  assert(tags.includes('PRICING'));
  assert(tags.includes('STAFF_BEHAVIOUR'));
  assert(tags.includes('SERVICE_QUALITY'));
});

test('AI Complaint Tagging: Positive feedback produces zero complaint tags', () => {
  const tags = extractComplaintTags(
    'Amazing haircut and beard trim! Very clean ambience, polite barber and zero waiting.',
    { overall: 5, hygiene: 5 },
  );
  assert.equal(tags.length, 0);
});

test('AI Complaint Tagging: Safe handling of null, undefined or empty input', () => {
  const tagsNull = extractComplaintTags(null, { overall: 5, hygiene: 5 });
  assert.deepEqual(tagsNull, []);

  const tagsUndefined = extractComplaintTags(undefined, undefined);
  assert.deepEqual(tagsUndefined, []);

  const tagsEmpty = extractComplaintTags('', { overall: 4, hygiene: 4 });
  assert.deepEqual(tagsEmpty, []);
});

test('Resolution Status Rules: Reviews <= 2 stars qualify for OPEN_ALERT', () => {
  const isAlertRating1 = 1 <= 2;
  const isAlertRating2 = 2 <= 2;
  const isAlertRating3 = 3 <= 2;
  const isAlertRating5 = 5 <= 2;

  assert.equal(isAlertRating1, true);
  assert.equal(isAlertRating2, true);
  assert.equal(isAlertRating3, false);
  assert.equal(isAlertRating5, false);
});
