import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kenyaMonthRange,
  normalizeKenyanPhone,
  validateDeliveryOrder,
  validatePaymentRequest
} from '../src/validation.js';
import { mpesaTimestamp } from '../src/mpesa.js';

const validOrder = {
  name: 'Jane Wanjiru',
  phone: '0712 345 678',
  payerPhone: '+254 712 345 678',
  email: 'jane@example.com',
  building: 'Sunrise Apartments',
  room: 'Room B4',
  floor: 'Second floor',
  date: '2026-11-05',
  time: '10:00 AM',
  services: ['Sofa Cleaning', 'Pillow Cleaning'],
  notes: 'Call on arrival',
  amount: 1250
};

test('normalizes accepted Kenyan phone formats', () => {
  assert.equal(normalizeKenyanPhone('0712 345 678'), '254712345678');
  assert.equal(normalizeKenyanPhone('+254-712-345-678'), '254712345678');
  assert.equal(normalizeKenyanPhone('0112 345 678'), '254112345678');
  assert.throws(() => normalizeKenyanPhone('12345'), /valid Kenyan mobile number/);
});

test('accepts a customer-entered whole-shilling amount and normalizes order phones', () => {
  const order = validatePaymentRequest(validOrder);
  assert.equal(order.amount, 1250);
  assert.equal(order.phone, '254712345678');
  assert.equal(order.payerPhone, '254712345678');
  assert.deepEqual(order.services, ['Sofa Cleaning', 'Pillow Cleaning']);
});

test('rejects invalid amounts, services, and calendar dates', () => {
  for (const amount of [0, -1, 1.5, 250001, 'not a number']) {
    assert.throws(() => validatePaymentRequest({ ...validOrder, amount }), /Amount must be/);
  }
  assert.throws(
    () => validatePaymentRequest({ ...validOrder, services: ['Unlisted service'] }),
    /invalid service/
  );
  assert.throws(
    () => validatePaymentRequest({ ...validOrder, date: '2026-02-31' }),
    /valid picking date/
  );
});

test('calculates monthly transaction bounds in Kenya time', () => {
  const { start, end } = kenyaMonthRange('2026-11');
  assert.equal(start.toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(end.toISOString(), '2026-11-30T21:00:00.000Z');
  assert.throws(() => kenyaMonthRange('2026-13'), /valid month/);
});

test('accepts pay on delivery orders with optional amount and defaults payerPhone', () => {
  const deliveryOrder = validateDeliveryOrder({ ...validOrder, amount: '', payerPhone: '' });
  assert.equal(deliveryOrder.amount, 0);
  assert.equal(deliveryOrder.payerPhone, '254712345678');
  assert.equal(deliveryOrder.paymentTiming, 'after');

  const deliveryWithAmount = validateDeliveryOrder({ ...validOrder, amount: 800 });
  assert.equal(deliveryWithAmount.amount, 800);
});

test('formats Daraja timestamps using East Africa Time', () => {
  assert.equal(mpesaTimestamp(new Date('2026-11-04T07:52:59.000Z')), '20261104105259');
});
