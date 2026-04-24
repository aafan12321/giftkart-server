const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { Resend } = require('resend');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ─── Razorpay ─────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: 'rzp_test_SgBnUHFf2EeuVz',
  key_secret: '443AtQ4Dsg9D1afcspfORkzn',
});

// ─── Resend (Email) ───────────────────────────────────────────────────────────
const resend = new Resend('re_eeoXDsn6_KASEL31DoTF78LcAY33CfwDG');

// ─── Twilio (WhatsApp) ────────────────────────────────────────────────────────
const twilioClient = twilio(
  'AC0df2b98e0508cbdb83774ca207abcc79',
  '8dc831bd39ab6b3105b966e8ef2010d4'
);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Server v4 ✅ — Resend email + WhatsApp' });
});

// ─── Send notifications in background ────────────────────────────────────────
function sendNotifications({ orderId, productName, amount, quantity, address, paymentMethod, paymentId }) {
  const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name = address?.name || 'Customer';
  const phone = address?.phone || 'N/A';
  const fullAddress = address
    ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}`
    : 'Not provided';

  // ── Email via Resend ───────────────────────────────────────────────────────
  resend.emails.send({
    from: 'GiftKart Orders <onboarding@resend.dev>',
    to: 'malikaafan50@gmail.com',
    subject: `🎁 New Order - ${orderId} | ₹${amount} | ${productName}`,
    html: `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="margin:0">🎁 New Order!</h1>
        <p style="margin:8px 0 0;font-size:18px">Order ID: <strong>${orderId}</strong></p>
        <p style="margin:4px 0 0;font-size:13px;opacity:0.85">${orderDate}</p>
      </div>
      <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px">
        <div style="background:white;padding:20px;border-radius:10px;margin-bottom:16px">
          <h2 style="color:#667eea;margin-top:0">📦 Order Details</h2>
          <p><b style="color:#667eea">Product:</b> ${productName}</p>
          <p><b style="color:#667eea">Quantity:</b> ${quantity}</p>
          <p><b style="color:#667eea">Payment:</b> ${paymentMethod}</p>
          <p><b style="color:#667eea">Status:</b> <span style="background:#4CAF50;color:white;padding:2px 10px;border-radius:20px;font-size:12px">✅ CONFIRMED</span></p>
          ${paymentId ? `<p><b style="color:#667eea">Payment ID:</b> ${paymentId}</p>` : ''}
        </div>
        <div style="font-size:28px;font-weight:800;color:#4CAF50;text-align:center;padding:16px 0">💰 ₹${amount}</div>
        <div style="background:white;padding:20px;border-radius:10px">
          <h2 style="color:#667eea;margin-top:0">📍 Delivery Address</h2>
          <p><b style="color:#667eea">Name:</b> ${name}</p>
          <p><b style="color:#667eea">Phone:</b> +91 ${phone}</p>
          <p><b style="color:#667eea">Address:</b> ${fullAddress}</p>
        </div>
        <p style="text-align:center;color:#aaa;font-size:11px;margin-top:20px">GiftKart • ${orderDate}</p>
      </div>
    </div>`,
  }).then(() => {
    console.log('📧 Email sent!');
  }).catch(err => {
    console.error('❌ Email error:', err.message);
  });

  // ── WhatsApp via Twilio ────────────────────────────────────────────────────
  twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: 'whatsapp:+917889677109',
    body: `🎁 *New GiftKart Order!*\n\n📋 *Order ID:* ${orderId}\n📅 *Date:* ${orderDate}\n\n📦 *Product:* ${productName}\n🔢 *Quantity:* ${quantity}\n💳 *Payment:* ${paymentMethod}\n💰 *Amount:* ₹${amount}\n✅ *Status:* CONFIRMED\n\n👤 *Customer:* ${name}\n📞 *Phone:* +91 ${phone}\n📍 *Address:* ${fullAddress}${paymentId ? `\n\n🔖 *Payment ID:* ${paymentId}` : ''}`,
  }).then(() => {
    console.log('📱 WhatsApp sent!');
  }).catch(err => {
    console.error('❌ WhatsApp error:', err.message);
  });
}

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;
    if (!amount || typeof amount !== 'number' || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }
    const order = await razorpay.orders.create({
      amount: Math.round(amount),
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: { product_name: product_name || 'GiftKart Product' },
    });
    console.log(`✅ Order created: ${order.id} | ₹${amount / 100}`);
    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: 'rzp_test_SgBnUHFf2EeuVz',
    });
  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// ─── VERIFY PAYMENT + NOTIFY ──────────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    const { payment_id, order_id, signature, product_name, amount, quantity, address } = req.body;

    if (!payment_id || !order_id || !signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const expected = crypto
      .createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn')
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    if (expected !== signature) {
      console.warn(`❌ Signature mismatch for ${order_id}`);
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    }

    const orderId = `GK${Date.now()}`;
    console.log(`✅ Payment verified: ${payment_id} → ${orderId}`);

    // Respond to app immediately
    res.json({ success: true, order_id: orderId, payment_id });

    // Send notifications in background
    setImmediate(() => {
      sendNotifications({
        orderId,
        productName: product_name || 'GiftKart Product',
        amount: amount || 0,
        quantity: quantity || 1,
        address: address || {},
        paymentMethod: 'Online Payment (Razorpay)',
        paymentId: payment_id,
      });
    });

  } catch (error) {
    console.error('❌ Verify error:', error);
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

// ─── CASH ON DELIVERY ─────────────────────────────────────────────────────────
app.post('/cod-order', async (req, res) => {
  try {
    const { product_name, amount, quantity, address } = req.body;
    if (!product_name || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const orderId = `GK${Date.now()}`;
    console.log(`📦 COD Order: ${orderId}`);

    res.json({ success: true, order_id: orderId });

    setImmediate(() => {
      sendNotifications({
        orderId,
        productName: product_name,
        amount,
        quantity: quantity || 1,
        address: address || {},
        paymentMethod: 'Cash on Delivery',
        paymentId: null,
      });
    });

  } catch (error) {
    console.error('❌ COD error:', error);
    res.status(500).json({ error: 'COD order error', details: error.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GiftKart Server v4 on port ${PORT}`);
  console.log(`   📧 Email: Resend → malikaafan50@gmail.com`);
  console.log(`   📱 WhatsApp: Twilio → +917889677109`);
});
