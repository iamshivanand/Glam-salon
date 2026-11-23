import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidGstin, isValidIfsc, isValidPan, normalizeCode } from '../src/validation.js';

test('normalizeCode strips spaces and upper-cases identifiers', () => {
  assert.equal(normalizeCode(' abcde1234f '), 'ABCDE1234F');
  assert.equal(normalizeCode('hdfc 0001234'), 'HDFC0001234');
});

test('PAN validation requires the 5-4-1 shape', () => {
  assert.equal(isValidPan('ABCDE1234F'), true);
  assert.equal(isValidPan('abcde1234f'), true);
  assert.equal(isValidPan('ABCDE12345'), false);
  assert.equal(isValidPan('ABCD1234F'), false);
  assert.equal(isValidPan('ABCDE1234'), false);
});

test('GSTIN validation requires 15 characters with the Z marker', () => {
  assert.equal(isValidGstin('29ABCDE1234F1Z5'), true);
  assert.equal(isValidGstin('29ABCDE1234F1A5'), false);
  assert.equal(isValidGstin('29ABCDE1234F1Z'), false);
});

test('IFSC validation requires the zero branch marker', () => {
  assert.equal(isValidIfsc('HDFC0001234'), true);
  assert.equal(isValidIfsc('HDFC1001234'), false);
  assert.equal(isValidIfsc('HDFC001234'), false);
});
