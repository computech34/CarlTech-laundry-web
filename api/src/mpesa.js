import crypto from 'node:crypto';

function mpesaBaseUrl() {
  const environment = process.env.MPESA_ENV;
  if (environment === 'production') return 'https://api.safaricom.co.ke';
  if (environment === 'sandbox') return 'https://sandbox.safaricom.co.ke';
  throw new Error('MPESA_ENV must be sandbox or production.');
}

export function mpesaConfigured() {
  return Boolean(
    process.env.MPESA_SHORTCODE &&
    process.env.MPESA_CONSUMER_KEY &&
    process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_PASSKEY &&
    process.env.MPESA_CALLBACK_SECRET &&
    (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_API_URL)
  );
}

export function mpesaTimestamp(date = new Date()) {
  const part = value => String(value).padStart(2, '0');
  const nairobiTime = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return `${nairobiTime.getUTCFullYear()}${part(nairobiTime.getUTCMonth() + 1)}${part(nairobiTime.getUTCDate())}${part(nairobiTime.getUTCHours())}${part(nairobiTime.getUTCMinutes())}${part(nairobiTime.getUTCSeconds())}`;
}

function mpesaPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const response = await fetch(`${mpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`M-Pesa access-token request failed (${response.status}).`);
  }
  return result.access_token;
}

function callbackUrl() {
  const apiUrl = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  const callbackToken = crypto.createHash('sha256').update(process.env.MPESA_CALLBACK_SECRET).digest('hex');
  return `${apiUrl}/api/payments/callback/${callbackToken}`;
}

export async function initiateStkPush({ amount, phone, paymentId }) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const timestamp = mpesaTimestamp();
  const accessToken = await getAccessToken();
  let response;
  try {
    response = await fetch(`${mpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: mpesaPassword(shortcode, process.env.MPESA_PASSKEY, timestamp),
        Timestamp: timestamp,
        TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerBuyGoodsOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl(),
        AccountReference: `CT${paymentId.slice(0, 8)}`,
        TransactionDesc: 'Laundry order'
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    error.ambiguous = true;
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error('M-Pesa returned an unreadable payment response.');
    error.ambiguous = true;
    throw error;
  }
  if (response.status >= 500) {
    const error = new Error('M-Pesa returned an uncertain payment response.');
    error.ambiguous = true;
    throw error;
  }
  if (result.ResponseCode === '0' && !result.CheckoutRequestID) {
    const error = new Error('M-Pesa accepted the request without a checkout reference.');
    error.ambiguous = true;
    throw error;
  }
  if (!response.ok || result.ResponseCode !== '0') {
    const message = result.errorMessage || result.ResponseDescription || `M-Pesa rejected the request (${response.status}).`;
    throw new Error(message);
  }
  return {
    checkoutRequestId: result.CheckoutRequestID,
    merchantRequestId: result.MerchantRequestID || '',
    customerMessage: result.CustomerMessage || 'Payment request sent to your phone.'
  };
}

export async function queryStkPush(checkoutRequestId) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const timestamp = mpesaTimestamp();
  const accessToken = await getAccessToken();
  const response = await fetch(`${mpesaBaseUrl()}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: mpesaPassword(shortcode, process.env.MPESA_PASSKEY, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || result.ResponseCode !== '0') {
    throw new Error(`M-Pesa payment verification request failed (${response.status}).`);
  }
  return result;
}
