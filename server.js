const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { Resend } = require('resend');
const twilio = require('twilio');

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

// ─── Twilio ───────────────────────────────────────────────────────────────────
const twilioClient = twilio(
  'AC0df2b98e0508cbdb83774ca207abcc79',
  '8b9fcab9add9923a3adf370771f5d278'
);
const TWILIO_VERIFY_SERVICE_SID = 'VA_REPLACE_WITH_YOUR_SERVICE_SID';

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Server v7 ✅ — OTP + payments + notifications' });
});

// ─── SEND OTP ─────────────────────────────────────────────────────────────────
app.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;

    const verification = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({
        to: formattedPhone,
        channel: 'sms',
      });

    console.log(`📱 OTP sent to ${formattedPhone}: ${verification.status}`);
    res.json({ success: true, status: verification.status });
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

    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;

    const check = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: formattedPhone,
        code,
      });

    console.log(`✅ OTP verified for ${formattedPhone}: ${check.status}`);

    if (check.status === 'approved') {
      res.json({ success: true, status: 'approved' });
    } else {
      res.json({ success: false, status: check.status });
    }
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

function sendNotifications({ orderId, productName, amount, quantity, address, paymentMethod, paymentId, photoBase64, customDetails }) {
  const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name = address?.name || 'Customer';
  const phone = address?.phone || 'N/A';
  const fullAddress = address ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}` : 'Not provided';

  const attachments = [];
  let photoHtml = '';
  if (photoBase64) {
    attachments.push({ filename: 'customer_photo.jpg', content: photoBase64 });
    photoHtml = `<div style="margin:16px 0;text-align:center"><p style="color:#667eea;font-weight:bold">📸 Customer Photo:</p><img src="data:image/jpeg;base64,${photoBase64}" style="max-width:100%;max-height:400px;border-radius:10px"/></div>`;
  }

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
  }).then(() => console.log('📧 Email sent!')).catch(err => console.error('❌ Email error:', err.message));

  twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: 'whatsapp:+917889677109',
    body: `🎁 *New GiftKart Order!*\n\n📋 *Order ID:* ${orderId}\n📅 *Date:* ${orderDate}\n\n📦 *Product:* ${productName}\n🔢 *Quantity:* ${quantity}\n💳 *Payment:* ${paymentMethod}\n💰 *Amount:* ₹${amount}\n✅ CONFIRMED${buildCustomText(customDetails)}\n\n👤 *Customer:* ${name}\n📞 *Phone:* +91 ${phone}\n📍 *Address:* ${fullAddress}${paymentId ? `\n\n🔖 *Payment ID:* ${paymentId}` : ''}${photoBase64 ? '\n\n📸 Photo in email.' : ''}`,
  }).then(() => console.log('📱 WhatsApp sent!')).catch(err => console.error('❌ WhatsApp error:', err.message));
}

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;
    if (!amount || typeof amount !== 'number' || amount < 100) return res.status(400).json({ error: 'Invalid amount.' });
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
    if (!payment_id || !order_id || !signature) return res.status(400).json({ error: 'Missing required fields' });
    const expected = crypto.createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn').update(`${order_id}|${payment_id}`).digest('hex');
    if (expected !== signature) { console.warn(`❌ Signature mismatch`); return res.status(400).json({ success: false, error: 'Payment verification failed.' }); }
    const orderId = `GK${Date.now()}`;
    console.log(`✅ Payment verified: ${payment_id} → ${orderId}`);
    res.json({ success: true, order_id: orderId, payment_id });
    setImmediate(() => sendNotifications({ orderId, productName: product_name || 'GiftKart Product', amount: amount || 0, quantity: quantity || 1, address: address || {}, paymentMethod: 'Online Payment (Razorpay)', paymentId: payment_id, photoBase64: photo_base64 || null, customDetails: custom_details || null }));
  } catch (error) {
    console.error('❌ Verify error:', error);
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

// ─── COD ORDER ────────────────────────────────────────────────────────────────
app.post('/cod-order', async (req, res) => {
  try {
    const { product_name, amount, quantity, address, photo_base64, custom_details } = req.body;
    if (!product_name || !amount) return res.status(400).json({ error: 'Missing required fields' });
    const orderId = `GK${Date.now()}`;
    console.log(`📦 COD Order: ${orderId}`);
    res.json({ success: true, order_id: orderId });
    setImmediate(() => sendNotifications({ orderId, productName: product_name, amount, quantity: quantity || 1, address: address || {}, paymentMethod: 'Cash on Delivery', paymentId: null, photoBase64: photo_base64 || null, customDetails: custom_details || null }));
  } catch (error) {
    console.error('❌ COD error:', error);
    res.status(500).json({ error: 'COD order error', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 GiftKart Server v7 on port ${PORT}`));
