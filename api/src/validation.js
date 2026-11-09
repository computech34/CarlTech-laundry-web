export const MAX_PAYMENT_AMOUNT = 250000;

const ALLOWED_SERVICES = new Set([
  'Clothes Laundry',
  'Sofa Cleaning',
  'Pillow Cleaning',
  'Mat & Carpet',
  'Shoe Cleaning',
  'Floor Cleaning',
  'Window Cleaning',
  'Vacuum Cleaning',
  'Office Cleaning'
]);

function text(value, field, maxLength, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new Error(`${field} is required and must be at most ${maxLength} characters.`);
  }
  return result;
}

export function normalizeKenyanPhone(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid Kenyan mobile number.');
  const digits = value.trim().replace(/[\s()+-]/g, '');
  const normalized = digits.startsWith('0') ? `254${digits.slice(1)}` : digits;
  if (!/^254(?:7|1)\d{8}$/.test(normalized)) {
    throw new Error('Enter a valid Kenyan mobile number, such as 0712 345 678.');
  }
  return normalized;
}

export function validatePaymentRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Enter your order details before requesting payment.');
  }
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_PAYMENT_AMOUNT) {
    throw new Error(`Amount must be a whole-shilling value from KSh 1 to KSh ${MAX_PAYMENT_AMOUNT}.`);
  }
  if (!Array.isArray(body.services) || !body.services.length || body.services.length > ALLOWED_SERVICES.size) {
    throw new Error('Select at least one valid service.');
  }
  const services = [...new Set(body.services)];
  if (services.some(service => typeof service !== 'string' || !ALLOWED_SERVICES.has(service))) {
    throw new Error('The order contains an invalid service.');
  }
  const date = text(body.date, 'Picking date', 10);
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('Enter a valid picking date.');
  }
  const allowedTimes = new Set([
    '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM',
    '12:00 PM', '1:00 PM', '2:00 PM', '2:30 PM (Last picking slot)'
  ]);
  const time = text(body.time, 'Picking time', 40);
  if (!allowedTimes.has(time)) throw new Error('Select a valid picking time.');
  const email = text(body.email, 'Email', 254, true);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  return {
    name: text(body.name, 'Name', 120),
    phone: normalizeKenyanPhone(body.phone),
    payerPhone: normalizeKenyanPhone(body.payerPhone),
    email,
    building: text(body.building, 'Building / estate', 160),
    room: text(body.room, 'Room / house', 80),
    floor: text(body.floor || 'N/A', 'Floor / level', 80),
    date,
    time,
    services,
    notes: text(body.notes || 'None', 'Special instructions', 500),
    amount
  };
}

export function validateDeliveryOrder(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Enter your order details before placing your booking.');
  }
  const rawAmount = body.amount !== undefined && body.amount !== null && body.amount !== '' ? Number(body.amount) : 0;
  let amount = 0;
  if (rawAmount > 0) {
    if (!Number.isSafeInteger(rawAmount) || rawAmount > MAX_PAYMENT_AMOUNT) {
      throw new Error(`Amount must be a whole-shilling value up to KSh ${MAX_PAYMENT_AMOUNT}.`);
    }
    amount = rawAmount;
  }
  if (!Array.isArray(body.services) || !body.services.length || body.services.length > ALLOWED_SERVICES.size) {
    throw new Error('Select at least one valid service.');
  }
  const services = [...new Set(body.services)];
  if (services.some(service => typeof service !== 'string' || !ALLOWED_SERVICES.has(service))) {
    throw new Error('The order contains an invalid service.');
  }
  const date = text(body.date, 'Picking date', 10);
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('Enter a valid picking date.');
  }
  const allowedTimes = new Set([
    '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM',
    '12:00 PM', '1:00 PM', '2:00 PM', '2:30 PM (Last picking slot)'
  ]);
  const time = text(body.time, 'Picking time', 40);
  if (!allowedTimes.has(time)) throw new Error('Select a valid picking time.');
  const email = text(body.email, 'Email', 254, true);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const phone = normalizeKenyanPhone(body.phone);
  const payerPhone = body.payerPhone ? normalizeKenyanPhone(body.payerPhone) : phone;

  return {
    name: text(body.name, 'Name', 120),
    phone,
    payerPhone,
    email,
    building: text(body.building, 'Building / estate', 160),
    room: text(body.room, 'Room / house', 80),
    floor: text(body.floor || 'N/A', 'Floor / level', 80),
    date,
    time,
    services,
    notes: text(body.notes || 'None', 'Special instructions', 500),
    amount,
    paymentTiming: 'after'
  };
}

export function kenyaMonthRange(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('Select a valid month.');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const kenyaOffsetMs = 3 * 60 * 60 * 1000;
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1) - kenyaOffsetMs),
    end: new Date(Date.UTC(year, monthNumber, 1) - kenyaOffsetMs)
  };
}
