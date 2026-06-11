cat > /home/claude/server.js << 'EOF'
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { Resend } = require('resend');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ─── Razorpay ─────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: 'rzp_test_SgBnUHFf2EeuVz',
  key_secret: '443AtQ4Dsg9D1afcspfORkzn',
});

// ─── Resend ───────────────────────────────────────────────────────────────────
const resend = new Resend('re_eeoXDsn6_KASEL31DoTF78LcAY33CfwDG');

// ─── MSG91 Config ─────────────────────────────────────────────────────────────
const MSG91_AUTH_KEY    = '518159Ahc2alc7V6a0cac25P1';
const MSG91_TEMPLATE_ID = '6a0cae1c04c4e4256407e123';
const MSG91_SENDER_ID   = 'GFTKRT';

// ─── In-memory OTP store (phone → { otp, expiresAt }) ────────────────────────
const otpStore = new Map();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Server v8 ✅ — MSG91 OTP + payments + notifications + cancellations' });
});

// ─── SEND OTP ─────────────────────────────────────────────────────────────────
app.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const cleanPhone = phone.replace(/^\+91/, '').replace(/\D/g, '');
    if (cleanPhone.length !== 10)
      return res.status(400).json({ error: 'Invalid phone number' });

    const otp = generateOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(cleanPhone, { otp, expiresAt });

    const response = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({
        template_id: MSG91_TEMPLATE_ID,
        mobile: `91${cleanPhone}`,
        authkey: MSG91_AUTH_KEY,
        otp,
        sender: MSG91_SENDER_ID,
      }),
    });

    const data = await response.json();
    console.log(`📱 MSG91 send OTP to ${cleanPhone}:`, JSON.stringify(data));

    if (data.type === 'success' || response.ok) {
      res.json({ success: true, status: 'OTP sent' });
    } else {
      console.error('❌ MSG91 error:', data);
      res.status(500).json({ error: 'Failed to send OTP', details: data.message || JSON.stringify(data) });
    }
  } catch (error) {
    console.error('❌ Send OTP error:', error.message);
    res.status(500).json({ error: 'Failed to send OTP', details: error.message });
  }
});

// ─── VERIFY OTP ───────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

    const cleanPhone = phone.replace(/^\+91/, '').replace(/\D/g, '');
    const record = otpStore.get(cleanPhone);

    if (!record)
      return res.json({ success: false, status: 'OTP not found. Please request a new one.' });

    if (Date.now() > record.expiresAt) {
      otpStore.delete(cleanPhone);
      return res.json({ success: false, status: 'OTP expired. Please request a new one.' });
    }

    if (record.otp !== code.toString())
      return res.json({ success: false, status: 'Invalid OTP' });

    otpStore.delete(cleanPhone);
    console.log(`✅ OTP verified for ${cleanPhone}`);
    res.json({ success: true, status: 'approved' });
  } catch (error) {
    console.error('❌ Verify OTP error:', error.message);
    res.status(500).json({ error: 'Failed to verify OTP', details: error.message });
  }
});

// ─── Notification helpers ─────────────────────────────────────────────────────
function buildCustomHtml(customDetails) {
  if (!customDetails) return '';
  const labels = {
    customerName: 'Customer Name', calligraphyText: 'Calligraphy Text',
    designText: 'Design Text', fontStyle: 'Font Style', frameType: 'Frame Type',
    cupColor: 'Cup Color', size: 'Size', specialNotes: 'Special Notes',
  };
  let html = '<hr style="margin:15px 0;border:none;border-top:1px solid #eee"><h3 style="color:#667eea">🎨 Customization</h3>';
  for (const [key, label] of Object.entries(labels)) {
    if (customDetails[key]) html += `<p><b style="color:#667eea">${label}:</b> ${customDetails[key]}</p>`;
  }
  return html;
}

function buildCustomText(customDetails) {
  if (!customDetails) return '';
  const labels = {
    customerName: 'Name', calligraphyText: 'Text', designText: 'Design',
    fontStyle: 'Font', frameType: 'Frame', cupColor: 'Color', size: 'Size', specialNotes: 'Notes',
  };
  let text = '\n\n🎨 *Customization:*';
  for (const [key, label] of Object.entries(labels)) {
    if (customDetails[key]) text += `\n${label}: ${customDetails[key]}`;
  }
  return text;
}

// ─── Order notifications (new order) ─────────────────────────────────────────
async function sendNotifications({ orderId, productName, amount, quantity, address, paymentMethod, paymentId, photoBase64, customDetails }) {
  const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name = address?.name || 'Customer';
  const phone = address?.phone || 'N/A';
  const fullAddress = address
    ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}`
    : 'Not provided';

  const attachments = [];
  let photoHtml = '';
  if (photoBase64) {
    attachments.push({ filename: 'customer_photo.jpg', content: photoBase64 });
    photoHtml = `<div style="margin:16px 0;text-align:center"><p style="color:#667eea;font-weight:bold">📸 Customer Photo:</p><img src="data:image/jpeg;base64,${photoBase64}" style="max-width:100%;max-height:400px;border-radius:10px"/></div>`;
  }

  // Email
  resend.emails.send({
    from: 'GiftKart Orders <onboarding@resend.dev>',
    to: 'malikaafan50@gmail.com',
    subject: `🎁 New Order - ${orderId} | ₹${amount} | ${productName}`,
    attachments,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
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
          ${buildCustomHtml(customDetails)}
        </div>
        ${photoHtml}
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
  }).then(() => console.log('📧 Order email sent!'))
    .catch(err => console.error('❌ Email error:', err.message));

  // WhatsApp
  const waBody = `🎁 *New GiftKart Order!*\n\n📋 *Order ID:* ${orderId}\n📅 *Date:* ${orderDate}\n\n📦 *Product:* ${productName}\n🔢 *Quantity:* ${quantity}\n💳 *Payment:* ${paymentMethod}\n💰 *Amount:* ₹${amount}\n✅ CONFIRMED${buildCustomText(customDetails)}\n\n👤 *Customer:* ${name}\n📞 *Phone:* +91 ${phone}\n📍 *Address:* ${fullAddress}${paymentId ? `\n\n🔖 *Payment ID:* ${paymentId}` : ''}${photoBase64 ? '\n\n📸 Photo in email.' : ''}`;

  fetch('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
    body: JSON.stringify({
      integrated_number: '917889677109',
      content_type: 'template',
      payload: { to: '917889677109', type: 'text', text: { body: waBody } },
    }),
  }).then(r => r.json())
    .then(d => console.log('📱 WhatsApp sent:', JSON.stringify(d)))
    .catch(err => console.error('❌ WhatsApp error:', err.message));
}

// ─── Cancellation notifications ───────────────────────────────────────────────
async function sendCancellationNotifications({ orderId, productName, amount, quantity, address, paymentMethod, orderDate }) {
  const requestedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name        = address?.name    || 'Customer';
  const phone       = address?.phone   || 'N/A';
  const fullAddress = address
    ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}`
    : 'Not provided';

  // ── Email via Resend ────────────────────────────────────────────────────────
  resend.emails.send({
    from: 'GiftKart Orders <onboarding@resend.dev>',
    to: 'malikaafan50@gmail.com',
    subject: `🚫 Cancellation Request — ${orderId} | ${productName}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,#e53935,#c62828);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="margin:0;font-size:28px">🚫 Cancellation Request</h1>
        <p style="margin:8px 0 0;font-size:16px">Order ID: <strong>${orderId}</strong></p>
        <p style="margin:4px 0 0;font-size:12px;opacity:0.85">Requested at: ${requestedAt}</p>
      </div>

      <div style="background:#f9f9f9;padding:24px;border-radius:0 0 12px 12px">

        <!-- Alert banner -->
        <div style="background:#fff3e0;border-left:4px solid #FF9800;padding:14px 18px;border-radius:8px;margin-bottom:20px">
          <p style="margin:0;color:#e65100;font-weight:bold;font-size:14px">
            ⚠️ A customer has requested cancellation. Please review and take action within 24 hours.
          </p>
        </div>

        <!-- Order Details -->
        <div style="background:white;padding:20px;border-radius:10px;margin-bottom:16px">
          <h2 style="color:#e53935;margin-top:0">📦 Order Details</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#888;width:140px">Product</td><td style="padding:6px 0;font-weight:bold">${productName}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Quantity</td><td style="padding:6px 0;font-weight:bold">${quantity}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Amount</td><td style="padding:6px 0;font-weight:bold;color:#e53935;font-size:18px">₹${amount}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Payment</td><td style="padding:6px 0;font-weight:bold">${paymentMethod}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Order Date</td><td style="padding:6px 0;font-weight:bold">${orderDate}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Status</td><td style="padding:6px 0"><span style="background:#FF9800;color:white;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:bold">🕐 CANCELLATION REQUESTED</span></td></tr>
          </table>
        </div>

        <!-- Delivery Address -->
        <div style="background:white;padding:20px;border-radius:10px">
          <h2 style="color:#e53935;margin-top:0">📍 Delivery Address</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#888;width:140px">Name</td><td style="padding:6px 0;font-weight:bold">${name}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Phone</td><td style="padding:6px 0;font-weight:bold">+91 ${phone}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Address</td><td style="padding:6px 0;font-weight:bold">${fullAddress}</td></tr>
          </table>
        </div>

        <p style="text-align:center;color:#aaa;font-size:11px;margin-top:20px">
          GiftKart • ${requestedAt}
        </p>
      </div>
    </div>`,
  }).then(() => console.log('📧 Cancellation email sent!'))
    .catch(err => console.error('❌ Cancellation email error:', err.message));

  // ── WhatsApp via MSG91 ──────────────────────────────────────────────────────
  const waBody =
    `🚫 *Cancellation Request — GiftKart*\n\n` +
    `📋 *Order ID:* ${orderId}\n` +
    `⏰ *Requested:* ${requestedAt}\n\n` +
    `📦 *Product:* ${productName}\n` +
    `🔢 *Quantity:* ${quantity}\n` +
    `💰 *Amount:* ₹${amount}\n` +
    `💳 *Payment:* ${paymentMethod}\n` +
    `📅 *Order Date:* ${orderDate}\n` +
    `🕐 *Status:* CANCELLATION REQUESTED\n\n` +
    `👤 *Customer:* ${name}\n` +
    `📞 *Phone:* +91 ${phone}\n` +
    `📍 *Address:* ${fullAddress}\n\n` +
    `⚠️ Please review and process this cancellation within 24 hours.`;

  fetch('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
    body: JSON.stringify({
      integrated_number: '917889677109',
      content_type: 'template',
      payload: { to: '917889677109', type: 'text', text: { body: waBody } },
    }),
  }).then(r => r.json())
    .then(d => console.log('📱 Cancellation WhatsApp sent:', JSON.stringify(d)))
    .catch(err => console.error('❌ Cancellation WhatsApp error:', err.message));
}

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;
    if (!amount || typeof amount !== 'number' || amount < 100)
      return res.status(400).json({ error: 'Invalid amount.' });
    const order = await razorpay.orders.create({
      amount: Math.round(amount), currency,
      receipt: `receipt_${Date.now()}`,
      notes: { product_name: product_name || 'GiftKart Product' },
    });
    console.log(`✅ Order created: ${order.id} | ₹${amount / 100}`);
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, key_id: 'rzp_test_SgBnUHFf2EeuVz' });
  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// ─── VERIFY PAYMENT ───────────────────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    const { payment_id, order_id, signature, product_name, amount, quantity, address, photo_base64, custom_details } = req.body;
    if (!payment_id || !order_id || !signature)
      return res.status(400).json({ error: 'Missing required fields' });
    const expected = crypto.createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn')
      .update(`${order_id}|${payment_id}`).digest('hex');
    if (expected !== signature) {
      console.warn('❌ Signature mismatch');
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    }
    const orderId = `GK${Date.now()}`;
    console.log(`✅ Payment verified: ${payment_id} → ${orderId}`);
    res.json({ success: true, order_id: orderId, payment_id });
    setImmediate(() => sendNotifications({
      orderId, productName: product_name || 'GiftKart Product',
      amount: amount || 0, quantity: quantity || 1, address: address || {},
      paymentMethod: 'Online Payment (Razorpay)', paymentId: payment_id,
      photoBase64: photo_base64 || null, customDetails: custom_details || null,
    }));
  } catch (error) {
    console.error('❌ Verify error:', error);
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

// ─── COD ORDER ────────────────────────────────────────────────────────────────
app.post('/cod-order', async (req, res) => {
  try {
    const { product_name, amount, quantity, address, photo_base64, custom_details } = req.body;
    if (!product_name || !amount)
      return res.status(400).json({ error: 'Missing required fields' });
    const orderId = `GK${Date.now()}`;
    console.log(`📦 COD Order: ${orderId}`);
    res.json({ success: true, order_id: orderId });
    setImmediate(() => sendNotifications({
      orderId, productName: product_name, amount, quantity: quantity || 1,
      address: address || {}, paymentMethod: 'Cash on Delivery', paymentId: null,
      photoBase64: photo_base64 || null, customDetails: custom_details || null,
    }));
  } catch (error) {
    console.error('❌ COD error:', error);
    res.status(500).json({ error: 'COD order error', details: error.message });
  }
});

// ─── CANCEL ORDER ─────────────────────────────────────────────────────────────
app.post('/cancel-order', async (req, res) => {
  try {
    const { order_id, product_name, amount, quantity, payment_method, order_date, address } = req.body;

    if (!order_id || !product_name)
      return res.status(400).json({ error: 'Missing required fields' });

    console.log(`🚫 Cancellation request: ${order_id} — ${product_name}`);

    // Respond immediately so the app doesn't wait
    res.json({ success: true, order_id });

    // Send email + WhatsApp in background
    setImmediate(() => sendCancellationNotifications({
      orderId:       order_id,
      productName:   product_name,
      amount:        amount        || 0,
      quantity:      quantity      || 1,
      paymentMethod: payment_method || 'N/A',
      orderDate:     order_date    || 'N/A',
      address:       address       || {},
    }));
  } catch (error) {
    console.error('❌ Cancel order error:', error);
    res.status(500).json({ error: 'Cancellation error', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 GiftKart Server v8 on port ${PORT}`));
EOF
echo "Done"
