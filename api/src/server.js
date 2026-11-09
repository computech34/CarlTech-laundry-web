import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import connectMongo from 'connect-mongo';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import { initiateStkPush, mpesaConfigured, queryStkPush } from './mpesa.js';
import { kenyaMonthRange, validateDeliveryOrder, validatePaymentRequest } from './validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(__dirname, '../public');
const websiteDirectory = path.resolve(__dirname, '../../');
const port = Number(process.env.PORT || 3000);
const databaseName = process.env.MONGODB_DB || 'carltechLaundry';
const paymentCollectionName = 'payments';

function requireServerConfiguration() {
  const missing = ['MONGODB_URI', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'MPESA_CALLBACK_SECRET']
    .filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing required server settings: ${missing.join(', ')}`);
  if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  if (process.env.ADMIN_PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD must contain at least 16 characters.');
  if (process.env.MPESA_CALLBACK_SECRET.length < 32) {
    throw new Error('MPESA_CALLBACK_SECRET must contain at least 32 characters.');
  }
}

function callbackToken() {
  return crypto.createHash('sha256').update(process.env.MPESA_CALLBACK_SECRET).digest('hex');
}

function timingSafeSecretMatch(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function metadataValue(items, name) {
  const item = Array.isArray(items) ? items.find(entry => entry.Name === name) : undefined;
  return item?.Value;
}

function safeCsvCell(value) {
  let text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(values) {
  return `${values.map(safeCsvCell).join(',')}\r\n`;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function markPaymentPaid(payments, transaction, callbackMetadata) {
  const receipt = metadataValue(callbackMetadata, 'MpesaReceiptNumber');
  const amount = Number(metadataValue(callbackMetadata, 'Amount'));
  const phone = String(metadataValue(callbackMetadata, 'PhoneNumber') || '');
  if (!receipt || amount !== transaction.amount || phone !== transaction.payerPhone) {
    await payments.updateOne(
      { _id: transaction._id, status: { $ne: 'paid' } },
      {
        $set: {
          status: 'review',
          verificationMessage: 'M-Pesa callback details did not match the stored order.',
          callbackMetadata,
          updatedAt: new Date()
        }
      }
    );
    return false;
  }

  try {
    const result = await payments.updateOne(
      { _id: transaction._id, status: { $ne: 'paid' } },
      {
        $set: {
          status: 'paid',
          receipt,
          paidAt: new Date(),
          callbackMetadata,
          updatedAt: new Date(),
          verificationMessage: ''
        }
      }
    );
    return result.modifiedCount === 1 || (await payments.findOne({ _id: transaction._id }))?.status === 'paid';
  } catch (error) {
    if (error?.code === 11000) {
      await payments.updateOne(
        { _id: transaction._id, status: { $ne: 'paid' } },
        { $set: { status: 'review', verificationMessage: 'M-Pesa receipt is already recorded.', updatedAt: new Date() } }
      );
      return false;
    }
    throw error;
  }
}

async function verifyTransaction(payments, transaction) {
  if (!transaction?.checkoutRequestId || !transaction.callbackMetadata) {
    return { status: transaction?.status || 'not_found' };
  }
  const query = await queryStkPush(transaction.checkoutRequestId);
  if (String(query.ResultCode) !== '0') {
    await payments.updateOne(
      { _id: transaction._id, status: { $ne: 'paid' } },
      {
        $set: {
          status: 'review',
          verificationMessage: query.ResultDesc || 'M-Pesa has not confirmed this payment.',
          updatedAt: new Date()
        }
      }
    );
    return { status: 'review' };
  }
  const paid = await markPaymentPaid(payments, transaction, transaction.callbackMetadata);
  return { status: paid ? 'paid' : 'review' };
}

function createApplication({ payments, mongoClient }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'form-action': ["'self'"]
      }
    }
  }));
  app.use(express.json({ limit: '20kb' }));
  const allowedOrigins = (process.env.WEBSITE_ORIGINS || 'https://computech34.github.io,http://localhost:5500,http://localhost:8080')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || origin === 'null' || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('This website is not allowed to use the payment API.'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
  }));
  const sessionConfig = {
    name: 'carltech-admin',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000
    }
  };
  if (mongoClient) {
    sessionConfig.store = connectMongo.create({
      client: mongoClient,
      dbName: databaseName,
      collectionName: 'adminSessions',
      ttl: 60 * 60 * 8
    });
  }
  app.use(session(sessionConfig));
  app.use(express.static(publicDirectory, { index: false, maxAge: '1h' }));

  const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 6,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many payment requests. Please wait a few minutes and try again.' }
  });
  const statusLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please wait before trying again.' }
  });
  const transactions = payments;

  function requireAdmin(req, res, next) {
    if (req.session?.isAdmin === true) return next();
    return res.status(401).json({ error: 'Please log in to view transaction records.' });
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/admin', (_req, res) => res.sendFile(path.join(publicDirectory, 'admin.html')));

  app.post('/api/orders/delivery', paymentLimiter, asyncRoute(async (req, res) => {
    let order;
    try {
      order = validateDeliveryOrder(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const orderId = crypto.randomUUID();
    const now = new Date();
    const transaction = {
      _id: orderId,
      ...order,
      status: 'pay_on_delivery',
      createdAt: now,
      updatedAt: now
    };
    await transactions.insertOne(transaction);

    return res.status(201).json({
      orderId,
      status: 'pay_on_delivery',
      message: 'Booking placed successfully! Payment will be made upon delivery.'
    });
  }));

  app.post('/api/payments/stk-push', paymentLimiter, asyncRoute(async (req, res) => {
    if (!mpesaConfigured()) {
      return res.status(503).json({ error: 'Online M-Pesa payments are not configured yet. Contact CarlTech for payment arrangements.' });
    }
    let order;
    try {
      order = validatePaymentRequest(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const paymentId = crypto.randomUUID();
    const now = new Date();
    const transaction = {
      _id: paymentId,
      ...order,
      status: 'initiating',
      createdAt: now,
      updatedAt: now
    };
    const activeTransaction = await transactions.findOne({
      payerPhone: order.payerPhone,
      status: { $in: ['initiating', 'pending', 'review'] }
    });
    if (activeTransaction) {
      const ageMs = Date.now() - new Date(activeTransaction.createdAt).getTime();
      if (process.env.NODE_ENV === 'development' || ageMs > 45000) {
        await transactions.updateOne(
          { _id: activeTransaction._id },
          { $set: { status: 'cancelled', failureMessage: 'Superseded by new payment request.' } }
        );
      } else {
        return res.status(409).json({
          error: 'There is already an unresolved payment request for this M-Pesa number. Please wait a moment before trying again.'
        });
      }
    }
    await transactions.insertOne(transaction);

    let request;
    try {
      request = await initiateStkPush({
        amount: order.amount,
        phone: order.payerPhone,
        paymentId
      });
    } catch (error) {
      const uncertain = error.ambiguous === true;
      try {
        await transactions.updateOne(
          { _id: paymentId },
          {
            $set: {
              status: uncertain ? 'review' : 'failed',
              failureMessage: uncertain
                ? 'We could not confirm whether M-Pesa created the prompt. Do not retry until the payment status is checked.'
                : 'M-Pesa did not accept the payment request.',
              updatedAt: new Date()
            }
          }
        );
      } catch (databaseError) {
        console.error('Could not update failed M-Pesa request:', databaseError.message);
        if (!uncertain) return next(databaseError);
      }
      console.error('M-Pesa STK request failed:', error.message);
      if (uncertain) {
        return res.status(202).json({
          paymentId,
          status: 'review',
          message: 'We could not confirm whether M-Pesa created the prompt. Check your phone and do not retry if a prompt arrived; contact CarlTech to confirm the status.'
        });
      }
      return res.status(502).json({ error: 'M-Pesa could not start the payment prompt. Check the phone number and try again.' });
    }

    try {
      await transactions.updateOne(
        { _id: paymentId },
        {
          $set: {
            status: 'pending',
            checkoutRequestId: request.checkoutRequestId,
            merchantRequestId: request.merchantRequestId,
            updatedAt: new Date()
          }
        }
      );
    } catch (error) {
      console.error('M-Pesa accepted a prompt but its checkout reference could not be saved:', error.message);
      return res.status(202).json({
        paymentId,
        status: 'review',
        message: 'M-Pesa may have sent a payment prompt, but the reference could not be saved. Do not retry; check your phone and contact CarlTech to confirm the payment.'
      });
    }
    return res.status(202).json({ paymentId, status: 'pending', message: request.customerMessage });
  }));

  app.get('/api/payments/:paymentId/status', statusLimiter, asyncRoute(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.paymentId)) {
      return res.status(404).json({ error: 'Payment request not found.' });
    }
    const transaction = await transactions.findOne(
      { _id: req.params.paymentId },
      { projection: { status: 1, receipt: 1, failureMessage: 1, verificationMessage: 1, createdAt: 1 } }
    );
    if (!transaction) return res.status(404).json({ error: 'Payment request not found.' });

    // In development mode, auto-confirm after 7 seconds if still pending so local testing works smoothly
    if (process.env.NODE_ENV === 'development' && transaction.status === 'pending') {
      const elapsed = Date.now() - new Date(transaction.createdAt).getTime();
      if (elapsed > 7000) {
        const mockReceipt = `SANDBOX${Math.floor(10000000 + Math.random() * 90000000)}`;
        await transactions.updateOne(
          { _id: transaction._id },
          { $set: { status: 'paid', receipt: mockReceipt, paidAt: new Date(), updatedAt: new Date() } }
        );
        return res.json({
          status: 'paid',
          receipt: mockReceipt,
          message: 'Payment verified successfully.'
        });
      }
    }

    const waitingTooLong = transaction.status === 'pending' &&
      Date.now() - transaction.createdAt.getTime() > 15 * 60 * 1000;
    return res.json({
      status: transaction.status,
      receipt: transaction.receipt || null,
      message: transaction.failureMessage || transaction.verificationMessage ||
        (waitingTooLong ? 'M-Pesa has not sent a final status yet. Do not request or pay again until CarlTech checks the transaction.' : null)
    });
  }));

  app.post('/api/payments/callback/:secret', asyncRoute(async (req, res) => {
    if (!timingSafeSecretMatch(req.params.secret, callbackToken())) {
      return res.status(404).json({ error: 'Not found.' });
    }
    const callback = req.body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID || callback.ResultCode === undefined) {
      return res.status(400).json({ error: 'Invalid M-Pesa callback.' });
    }
    const transaction = await transactions.findOne({ checkoutRequestId: callback.CheckoutRequestID });
    if (!transaction) {
      console.error('M-Pesa callback did not match a pending payment request.');
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received.' });
    }
    if (String(callback.ResultCode) !== '0') {
      await transactions.updateOne(
        { _id: transaction._id, status: { $ne: 'paid' } },
        {
          $set: {
            status: 'failed',
            failureMessage: 'The M-Pesa request was cancelled or not completed.',
            updatedAt: new Date()
          }
        }
      );
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received.' });
    }

    const callbackMetadata = callback.CallbackMetadata?.Item || [];
    await transactions.updateOne(
      { _id: transaction._id, status: { $ne: 'paid' } },
      { $set: { status: 'review', callbackMetadata, updatedAt: new Date() } }
    );
    try {
      const current = await transactions.findOne({ _id: transaction._id });
      const verification = await verifyTransaction(transactions, current);
      if (verification.status !== 'paid') {
        console.error('M-Pesa callback received but payment needs manual review:', transaction._id);
      }
    } catch (error) {
      await transactions.updateOne(
        { _id: transaction._id, status: { $ne: 'paid' } },
        {
          $set: {
            status: 'review',
            verificationMessage: 'Automatic M-Pesa verification is temporarily unavailable.',
            updatedAt: new Date()
          }
        }
      );
      console.error('M-Pesa payment verification failed:', error.message);
    }
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received.' });
  }));

  app.post('/api/admin/login', loginLimiter, (req, res, next) => {
    const password = req.body?.password;
    if (!timingSafeSecretMatch(password, process.env.ADMIN_PASSWORD)) {
      return res.status(401).json({ error: 'The password was not accepted.' });
    }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.isAdmin = true;
      return req.session.save(saveError => {
        if (saveError) return next(saveError);
        return res.json({ authenticated: true });
      });
    });
  });

  app.post('/api/admin/logout', requireAdmin, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('carltech-admin', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
      });
      return res.json({ authenticated: false });
    });
  });

  app.get('/api/admin/transactions', requireAdmin, asyncRoute(async (req, res) => {
    let range;
    try {
      range = kenyaMonthRange(req.query.month);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const filter = { createdAt: { $gte: range.start, $lt: range.end } };
    const [summary = { paidCount: 0, paidTotal: 0, count: 0 }, rows] = await Promise.all([
      transactions.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            paidCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
            paidTotal: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }
          }
        }
      ]).toArray(),
      transactions.find(filter, {
        projection: {
          name: 1, phone: 1, payerPhone: 1, services: 1, amount: 1,
          status: 1, receipt: 1, createdAt: 1, verificationMessage: 1,
          checkoutRequestId: 1, callbackMetadata: 1
        }
      }).sort({ createdAt: -1 }).limit(1000).toArray()
    ]);
    return res.json({
      month: req.query.month,
      summary,
      hasMore: rows.length === 1000,
      transactions: rows.map(row => ({
        id: row._id,
        name: row.name,
        phone: row.phone,
        payerPhone: row.payerPhone,
        services: row.services,
        amount: row.amount,
        status: row.status,
        receipt: row.receipt || '',
        createdAt: row.createdAt,
        verificationMessage: row.verificationMessage || '',
        canReverify: row.status === 'review' && Boolean(row.checkoutRequestId && row.callbackMetadata),
        canClose: ['initiating', 'pending', 'review'].includes(row.status)
      }))
    });
  }));

  app.get('/api/admin/transactions.csv', requireAdmin, asyncRoute(async (req, res) => {
    let range;
    try {
      range = kenyaMonthRange(req.query.month);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const filter = { createdAt: { $gte: range.start, $lt: range.end } };
    const cursor = transactions.find(filter).sort({ createdAt: -1 });
    res.type('text/csv');
    res.attachment(`carltech-transactions-${req.query.month}.csv`);
    res.write(csvRow(['Created at (Kenya time)', 'Customer', 'Contact phone', 'M-Pesa phone', 'Services', 'Amount (KSh)', 'Status', 'M-Pesa receipt', 'Building', 'Room', 'Picking date', 'Picking time', 'Notes']));
    for await (const row of cursor) {
      res.write(csvRow([
        row.createdAt?.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }),
        row.name, row.phone, row.payerPhone, row.services?.join('; '),
        row.amount, row.status, row.receipt, row.building, row.room,
        row.date, row.time, row.notes
      ]));
    }
    return res.end();
  }));

  app.post('/api/admin/transactions/:id/reverify', requireAdmin, asyncRoute(async (req, res) => {
    const transaction = await transactions.findOne({ _id: req.params.id });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
    if (!transaction.checkoutRequestId || !transaction.callbackMetadata) {
      return res.status(409).json({ error: 'This transaction does not have enough M-Pesa callback data to verify.' });
    }
    try {
      const result = await verifyTransaction(transactions, transaction);
      return res.json(result);
    } catch (error) {
      console.error('Admin M-Pesa verification retry failed:', error.message);
      return res.status(502).json({ error: 'M-Pesa verification is currently unavailable. Try again later.' });
    }
  }));

  app.post('/api/admin/transactions/:id/close', requireAdmin, asyncRoute(async (req, res) => {
    if (req.body?.confirmNotPaid !== true) {
      return res.status(400).json({ error: 'Confirm that the transaction was checked and not paid.' });
    }
    const result = await transactions.updateOne(
      { _id: req.params.id, status: { $in: ['initiating', 'pending', 'review'] } },
      {
        $set: {
          status: 'cancelled',
          failureMessage: 'Administrator confirmed this request was not paid.',
          manuallyClosedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );
    if (!result.matchedCount) {
      return res.status(409).json({ error: 'This transaction is no longer open or was not found.' });
    }
    return res.json({ status: 'cancelled' });
  }));

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error.message === 'This website is not allowed to use the payment API.') {
      return res.status(403).json({ error: error.message });
    }
    console.error('Payment API request failed:', error.message);
    return res.status(500).json({ error: 'The request could not be completed. Please try again later.' });
  });

  return app;
}

function createInMemoryCollection() {
  const store = [];
  return {
    async insertOne(doc) {
      store.push({ ...doc });
      return { insertedId: doc._id };
    },
    async findOne(filter = {}) {
      const match = store.find(item => {
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && v.$in) {
            if (!v.$in.includes(item[k])) return false;
          } else if (v && typeof v === 'object' && v.$ne) {
            if (item[k] === v.$ne) return false;
          } else if (item[k] !== v) {
            return false;
          }
        }
        return true;
      });
      return match ? { ...match } : null;
    },
    async updateOne(filter = {}, update = {}) {
      const idx = store.findIndex(item => {
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && v.$in) {
            if (!v.$in.includes(item[k])) return false;
          } else if (v && typeof v === 'object' && v.$ne) {
            if (item[k] === v.$ne) return false;
          } else if (item[k] !== v) {
            return false;
          }
        }
        return true;
      });
      if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        Object.assign(store[idx], update.$set);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    find(filter = {}) {
      let results = store.filter(item => {
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && (v.$gte || v.$lt)) {
            const time = new Date(item[k]).getTime();
            if (v.$gte && time < new Date(v.$gte).getTime()) return false;
            if (v.$lt && time >= new Date(v.$lt).getTime()) return false;
          } else if (v && typeof v === 'object' && v.$in) {
            if (!v.$in.includes(item[k])) return false;
          } else if (item[k] !== v) {
            return false;
          }
        }
        return true;
      });
      return {
        sort(sortObj = {}) {
          if (sortObj.createdAt === -1) {
            results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          }
          return this;
        },
        limit(n) {
          results = results.slice(0, n);
          return this;
        },
        async toArray() {
          return results.map(r => ({ ...r }));
        }
      };
    },
    aggregate(pipeline = []) {
      const matchStage = pipeline.find(stage => stage.$match)?.$match || {};
      const cursor = this.find(matchStage);
      return {
        async toArray() {
          const items = await cursor.toArray();
          const count = items.length;
          const paidItems = items.filter(i => i.status === 'paid');
          const paidCount = paidItems.length;
          const paidTotal = paidItems.reduce((acc, i) => acc + (Number(i.amount) || 0), 0);
          return [{ _id: null, count, paidCount, paidTotal }];
        }
      };
    }
  };
}

async function start() {
  requireServerConfiguration();
  let mongoClient = null;
  let payments = null;

  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 3000
    });
    await mongoClient.connect();
    payments = mongoClient.db(databaseName).collection(paymentCollectionName);
    await Promise.all([
      payments.createIndex({ checkoutRequestId: 1 }, { sparse: true, unique: true }),
      payments.createIndex({ receipt: 1 }, { sparse: true, unique: true }),
      payments.createIndex({ createdAt: -1 }),
      payments.createIndex({ status: 1, createdAt: -1 }),
      payments.createIndex({ payerPhone: 1, status: 1, createdAt: -1 })
    ]);
    console.log(`Connected to MongoDB database: ${databaseName}`);
  } catch (dbError) {
    console.warn(`MongoDB not reached (${dbError.message}); using in-memory store for development.`);
    payments = createInMemoryCollection();
    mongoClient = null;
  }

  const app = createApplication({ payments, mongoClient });
  const server = app.listen(port, () => console.log(`CarlTech payment API listening on port ${port}.`));
  const shutdown = async () => {
    server.close(async () => {
      if (mongoClient) await mongoClient.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(error => {
  console.error('CarlTech payment API failed to start:', error.message);
  process.exitCode = 1;
});
