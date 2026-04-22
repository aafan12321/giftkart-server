const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ─── Razorpay ─────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: 'rzp_test_SgBnUHFf2EeuVz',
  key_secret: '443AtQ4Dsg9D1afcspfORkzn',
});

// ─── Gmail ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'malikaafan50@gmail.com',
    pass: 'vpql ywim jfyb alzy',
  },
});

// ─── Twilio ───────────────────────────────────────────────────────────────────
const twilioClient = twilio(
  'AC0df2b98e0508cbdb83774ca207abcc79',
  '8dc831bd39ab6b3105b966e8ef2010d4'
);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Server running ✅' });
});

// ─── Helper: Send notifications (email + WhatsApp) ────────────────────────────
async function sendOrderNotifications({ orderId, productName, amount, quantity, address, paymentMethod, paymentId }) {
  const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name = address?.name || 'Customer';
  const phone = address?.phone || 'N/A';
  const fullAddress = address
    ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}`
    : 'Not provided';

  // ── Email ──────────────────────────────────────────────────────────────────
  try {
    await transporter.sendMail({
      from: '"GiftKart Orders 🎁" <malikaafan50@gmail.com>',
      to: 'malikaafan50@gmail.com',
      subject: `🎁 New Order - ${orderId} | ₹${amount} | ${productName}`,
      html: `
<!DOCTYPE html><html><head><style>
  body{font-family:Arial,sans-serif;color:#333;line-height:1.6;margin:0;padding:0}
  .wrap{max-width:600px;margin:0 auto;padding:20px}
  .hdr{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:30px;text-align:center;border-radius:12px 12px 0 0}
  .body{background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px}
  .card{background:#fff;padding:20px;margin:16px 0;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,0.08)}
  .lbl{font-weight:700;color:#667eea;font-size:13px}
  .val{color:#222;font-size:14px}
  .total{font-size:28px;font-weight:800;color:#4CAF50;text-align:center;padding:16px 0}
  .badge{background:#4CAF50;color:#fff;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700}
  .method{background:#2196F3;color:#fff;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700}
  .footer{text-align:center;color:#aaa;font-size:11px;margin-top:20px}
  tr td{padding:6px 0}
</style></head><body><div class="wrap">
  <div class="hdr">
    <h1 style="margin:0;font-size:26px">🎁 New Order!</h1>
    <p style="margin:8px 0 0;font-size:16px">Order ID: <strong>${orderId}</strong></p>
    <p style="margin:4px 0 0;font-size:13px;opacity:0.85">${orderDate}</p>
  </div>
  <div class="body">
    <div class="card">
      <h2 style="margin-top:0;color:#667eea;font-size:17px">📦 Order Details</h2>
      <table width="100%">
        <tr><td class="lbl">Product</td><td class="val">${productName}</td></tr>
        <tr><td class="lbl">Quantity</td><td class="val">${quantity}</td></tr>
        <tr><td class="lbl">Payment Method</td><td><span class="method">${paymentMethod}</span></td></tr>
        <tr><td class="lbl">Status</td><td><span class="badge">✅ CONFIRMED</span></td></tr>
        ${paymentId ? `<tr><td class="lbl">Payment ID</td><td class="val" style="font-size:12px">${paymentId}</td></tr>` : ''}
      </table>
    </div>
    <div class="total">💰 ₹${amount}</div>
    <div class="card">
      <h2 style="margin-top:0;color:#667eea;font-size:17px">📍 Delivery Address</h2>
      <table width="100%">
        <tr><td class="lbl">Name</td><td class="val">${name}</td></tr>
        <tr><td class="lbl">Phone</td><td class="val">+91 ${phone}</td></tr>
        <tr><td class="lbl">Address</td><td class="val">${fullAddress}</td></tr>
      </table>
    </div>
    <div class="footer"><p>GiftKart Automated Notification • ${orderDate}</p></div>
  </div>
</div></body></html>`,
    });
    console.log('📧 Email sent!');
  } catch (e) {
    console.error('❌ Email error:', e.message);
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────
  try {
    await twilioClient.messages.create({
      from: 'whatsapp:+14155238886',
      to: 'whatsapp:+917889677109',
      body: `🎁 *New GiftKart Order!*

📋 *Order ID:* ${orderId}
📅 *Date:* ${orderDate}

📦 *Product:* ${productName}
🔢 *Quantity:* ${quantity}
💳 *Payment:* ${paymentMethod}
💰 *Amount:* ₹${amount}
✅ *Status:* CONFIRMED

👤 *Customer:* ${name}
📞 *Phone:* +91 ${phone}
📍 *Address:* ${fullAddress}
${paymentId ? `\n🔖 *Payment ID:* ${paymentId}` : ''}`,
    });
    console.log('📱 WhatsApp sent!');
  } catch (e) {
    console.error('❌ WhatsApp error:', e.message);
  }
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

// ─── VERIFY PAYMENT (Online) ──────────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    const { payment_id, order_id, signature, product_name, amount, quantity, address } = req.body;

    if (!payment_id || !order_id || !signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify signature
    const expected = crypto
      .createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn')
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    if (expected !== signature) {
      console.warn(`❌ Signature mismatch for ${order_id}`);
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    }

    const orderId = `GK${Date.now()}`;
    console.log(`✅ Payment verified: ${payment_id}`);

    // Respond immediately — don't wait for notifications
    res.json({ success: true, order_id: orderId, payment_id });

    // Send notifications in background (non-blocking)
    sendOrderNotifications({
      orderId,
      productName: product_name || 'GiftKart Product',
      amount: amount || 0,
      quantity: quantity || 1,
      address: address || {},
      paymentMethod: 'Online Payment (Razorpay)',
      paymentId: payment_id,
    });

  } catch (error) {
    console.error('❌ Verify error:', error);
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

// ─── CASH ON DELIVERY ORDER ───────────────────────────────────────────────────
app.post('/cod-order', async (req, res) => {
  try {
    const { product_name, amount, quantity, address } = req.body;

    if (!product_name || !amount || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderId = `GK${Date.now()}`;
    console.log(`📦 COD Order placed: ${orderId}`);

    // Respond immediately
    res.json({ success: true, order_id: orderId });

    // Send notifications in background
    sendOrderNotifications({
      orderId,
      productName: product_name,
      amount,
      quantity: quantity || 1,
      address,
      paymentMethod: 'Cash on Delivery',
      paymentId: null,
    });

  } catch (error) {
    console.error('❌ COD order error:', error);
    res.status(500).json({ error: 'COD order error', details: error.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GiftKart Server on port ${PORT}`);
});
