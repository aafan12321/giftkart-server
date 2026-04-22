const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ─── Razorpay instance ───────────────────────────────────────────────────────
// ⚠️  NEVER expose key_secret to the Flutter app — keep it only here
const razorpay = new Razorpay({
  key_id: 'rzp_test_SgBnUHFf2EeuVz',       // Key ID (safe to use in app)
  key_secret: '443AtQ4Dsg9D1afcspfORkzn',  // Key Secret (ONLY on server)
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Payment Server running ✅' });
});

// ─── STEP 1: Create Razorpay Order ───────────────────────────────────────────
// Flutter calls: POST /create-order  { amount: 50000 (in paise), product_name: "..." }
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;

    // Validate amount — never trust client blindly
    if (!amount || typeof amount !== 'number' || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount. Must be in paise (min ₹1 = 100 paise).' });
    }

    const options = {
      amount: Math.round(amount),   // paise, must be integer
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: {
        product_name: product_name || 'GiftKart Product',
      },
    };

    const order = await razorpay.orders.create(options);

    console.log(`✅ Order created: ${order.id} | ₹${amount / 100}`);

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: 'rzp_test_SgBnUHFf2EeuVz',  // Send Key ID to app (safe)
    });
  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// ─── STEP 2: Verify Payment Signature ────────────────────────────────────────
// Flutter calls: POST /verify-payment { payment_id, order_id, signature }
app.post('/verify-payment', (req, res) => {
  try {
    const { payment_id, order_id, signature } = req.body;

    if (!payment_id || !order_id || !signature) {
      return res.status(400).json({ error: 'Missing payment_id, order_id or signature' });
    }

    // Generate expected signature using HMAC-SHA256
    const body = `${order_id}|${payment_id}`;
    const expected_signature = crypto
      .createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn')
      .update(body)
      .digest('hex');

    const isValid = expected_signature === signature;

    if (isValid) {
      // ✅ Payment is legitimate
      console.log(`✅ Payment verified: ${payment_id} for order ${order_id}`);

      // TODO: Save to your database here
      // e.g. db.saveOrder({ payment_id, order_id, status: 'paid' })

      res.json({
        success: true,
        message: 'Payment verified successfully',
        payment_id,
        order_id,
      });
    } else {
      // ❌ Signature mismatch — possible fraud attempt
      console.warn(`❌ Signature mismatch for order ${order_id}`);
      res.status(400).json({
        success: false,
        error: 'Payment verification failed. Invalid signature.',
      });
    }
  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

// ─── STEP 3 (Optional): Razorpay Webhook ─────────────────────────────────────
// Set this URL in your Razorpay dashboard → Settings → Webhooks
// URL: https://your-server.com/webhook
app.post('/webhook', (req, res) => {
  const webhookSecret = 'your_webhook_secret_here'; // Set in Razorpay dashboard
  const signature = req.headers['x-razorpay-signature'];

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (signature === expectedSignature) {
    const event = req.body.event;
    console.log(`📩 Webhook received: ${event}`);

    if (event === 'payment.captured') {
      const payment = req.body.payload.payment.entity;
      console.log(`💰 Payment captured: ${payment.id}`);
      // TODO: Update order status in database
    }

    res.json({ status: 'ok' });
  } else {
    console.warn('❌ Invalid webhook signature');
    res.status(400).json({ error: 'Invalid signature' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GiftKart Payment Server running on port ${PORT}`);
  console.log(`   POST /create-order   — Create Razorpay order`);
  console.log(`   POST /verify-payment — Verify payment signature`);
  console.log(`   POST /webhook        — Razorpay webhook (optional)`);
});
