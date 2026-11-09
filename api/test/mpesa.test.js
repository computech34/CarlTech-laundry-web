import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initiateStkPush } from '../src/mpesa.js';

const environmentKeys = [
  'MPESA_ENV',
  'MPESA_SHORTCODE',
  'MPESA_TRANSACTION_TYPE',
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_PASSKEY',
  'MPESA_CALLBACK_SECRET',
  'PUBLIC_API_URL'
];

async function withMpesaEnvironment(run) {
  const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MPESA_ENV: 'sandbox',
    MPESA_SHORTCODE: '3608234',
    MPESA_TRANSACTION_TYPE: 'CustomerBuyGoodsOnline',
    MPESA_CONSUMER_KEY: 'test-consumer-key',
    MPESA_CONSUMER_SECRET: 'test-consumer-secret',
    MPESA_PASSKEY: 'test-passkey',
    MPESA_CALLBACK_SECRET: 'test-callback-secret',
    PUBLIC_API_URL: 'https://payments.example.test'
  });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('builds a sandbox STK request for the customer-entered amount and phone', async () => {
  await withMpesaEnvironment(async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ access_token: 'sandbox-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_123',
        MerchantRequestID: 'merchant_123',
        CustomerMessage: 'Prompt sent'
      }), { status: 200 });
    };

    const result = await initiateStkPush({
      amount: 3555,
      phone: '254712345678',
      paymentId: '123e4567-e89b-12d3-a456-426614174000'
    });

    assert.equal(result.checkoutRequestId, 'ws_CO_123');
    assert.match(calls[0].url, /^https:\/\/sandbox\.safaricom\.co\.ke\/oauth\//);
    assert.match(calls[1].url, /\/mpesa\/stkpush\/v1\/processrequest$/);
    const payload = JSON.parse(calls[1].options.body);
    assert.equal(payload.Amount, 3555);
    assert.equal(payload.PhoneNumber, '254712345678');
    assert.equal(payload.TransactionType, 'CustomerBuyGoodsOnline');
    assert.equal(payload.BusinessShortCode, '3608234');
    assert.equal(payload.AccountReference, 'CT123e4567');
    const callbackToken = crypto.createHash('sha256').update('test-callback-secret').digest('hex');
    assert.equal(payload.CallBackURL, `https://payments.example.test/api/payments/callback/${callbackToken}`);
    assert.equal(payload.TransactionDesc, 'Laundry order');
    assert.match(payload.Timestamp, /^\d{14}$/);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer sandbox-token');
  });
});

test('treats a lost STK response as uncertain to prevent duplicate payment prompts', async () => {
  await withMpesaEnvironment(async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 1) return new Response(JSON.stringify({ access_token: 'sandbox-token' }), { status: 200 });
      throw new Error('network timeout');
    };

    await assert.rejects(
      initiateStkPush({
        amount: 200,
        phone: '254712345678',
        paymentId: '123e4567-e89b-12d3-a456-426614174000'
      }),
      error => error.ambiguous === true
    );
  });
});
