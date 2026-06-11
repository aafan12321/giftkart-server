const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { Resend } = require('resend');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const razorpay = new Razorpay({
  key_id: 'rzp_test_SgBnUHFf2EeuVz',
  key_secret: '443AtQ4Dsg9D1afcspfORkzn',
});

const resend = new Resend('re_eeoXDsn6_KASEL31DoTF78LcAY33CfwDG');

const MSG91_AUTH_KEY    = '518159Ahc2alc7V6a0cac25P1';
const MSG91_TEMPLATE_ID = '6a0cae1c04c4e4256407e123';
const MSG91_SENDER_ID   = 'GFTKRT';

const otpStore = new Map();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Server v8 ✅' });
});

app.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    const cleanPhone = phone.replace(/^\+91/, '').replace(/\D/g, '');
    if (cleanPhone.length !== 10) return res.status(400).json({ error: 'Invalid phone number' });
    const otp = generateOtp();
    otpStore.set(cleanPhone, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
    const response = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({ template_id: MSG91_TEMPLATE_ID, mobile: `91${cleanPhone}`, authkey: MSG91_AUTH_KEY, otp, sender: MSG91_SENDER_ID }),
    });
    const data = await response.json();
    if (data.type === 'success' || response.ok) {
      res.json({ success: true, status: 'OTP sent' });
    } else {
      res.status(500).json({ error: 'Failed to send OTP', details: data.message });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to send OTP', details: error.message });
  }
});

app.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
    const cleanPhone = phone.replace(/^\+91/, '').replace(/\D/g, '');
    const record = otpStore.get(cleanPhone);
    if (!record) return res.json({ success: false, status: 'OTP not found. Please request a new one.' });
    if (Date.now() > record.expiresAt) { otpStore.delete(cleanPhone); return res.json({ success: false, status: 'OTP expired.' }); }
    if (record.otp !== code.toString()) return res.json({ success: false, status: 'Invalid OTP' });
    otpStore.delete(cleanPhone);
    res.json({ success: true, status: 'approved' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify OTP', details: error.message });
  }
});

function buildCustomHtml(customDetails) {
  if (!customDetails) return '';
  const labels = { customerName: 'Customer Name', calligraphyText: 'Calligraphy Text', designText: 'Design Text', fontStyle: 'Font Style', frameType: 'Frame Type', cupColor: 'Cup Color', size: 'Size', specialNotes: 'Special Notes' };
  let html = '<hr style="margin:15px 0"><h3 style="color:#667eea">🎨 Customization</h3>';
  for (const [key, label] of Object.entries(labels)) {
    if (customDetails[key]) html += `<p><b>${label}:</b> ${customDetails[key]}</p>`;
  }
  return html;
}

function buildCustomText(customDetails) {
  if (!customDetails) return '';
  const labels = { customerName: 'Name', calligraphyText: 'Text', designText: 'Design', fontStyle: 'Font', frameType: 'Frame', cupColor: 'Color', size: 'Size', specialNotes: 'Notes' };
  let text = '\n\n🎨 *Customization:*';
  for (const [key, label] of Object.entries(labels)) {
    if (customDetails[key]) text += `\n${label}: ${customDetails[key]}`;
  }
  return text;
}

async function sendNotifications({ orderId, productName, amount, quantity, address, paymentMethod, paymentId, photoBase64, customDetails }) {
  const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name = address?.name || 'Customer';
  const phone = address?.phone || 'N/A';
  const fullAddress = address ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}` : 'Not provided';
  const attachments = [];
  let photoHtml = '';
  if (photoBase64) {
    attachments.push({ filename: 'customer_photo.jpg', content: photoBase64 });
    photoHtml = `<div style="text-align:center"><img src="data:image/jpeg;base64,${photoBase64}" style="max-width:100%;max-height:400px;border-radius:10px"/></div>`;
  }
  resend.emails.send({
    from: 'GiftKart Orders <onboarding@resend.dev>',
    to: 'malikaafan50@gmail.com',
    subject: `🎁 New Order - ${orderId} | ₹${amount} | ${productName}`,
    attachments,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0"><h1 style="margin:0">🎁 New Order!</h1><p>Order ID: <strong>${orderId}</strong></p><p>${orderDate}</p></div><div style="background:#f9f9f9;padding:24px"><p><b>Product:</b> ${productName}</p><p><b>Quantity:</b> ${quantity}</p><p><b>Payment:</b> ${paymentMethod}</p>${paymentId ? `<p><b>Payment ID:</b> ${paymentId}</p>` : ''}${buildCustomHtml(customDetails)}${photoHtml}<p style="font-size:24px;color:#4CAF50;text-align:center">💰 ₹${amount}</p><p><b>Name:</b> ${name}</p><p><b>Phone:</b> +91 ${phone}</p><p><b>Address:</b> ${fullAddress}</p></div></div>`,
  }).then(() => console.log('📧 Email sent!')).catch(err => console.error('❌ Email error:', err.message));

  const waBody = `🎁 *New GiftKart Order!*\n\n📋 *Order ID:* ${orderId}\n📦 *Product:* ${productName}\n🔢 *Qty:* ${quantity}\n💳 *Payment:* ${paymentMethod}\n💰 *Amount:* ₹${amount}${buildCustomText(customDetails)}\n\n👤 *Customer:* ${name}\n📞 +91 ${phone}\n📍 ${fullAddress}${paymentId ? `\n\n🔖 *Payment ID:* ${paymentId}` : ''}`;
  fetch('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
    body: JSON.stringify({ integrated_number: '917889677109', content_type: 'template', payload: { to: '917889677109', type: 'text', text: { body: waBody } } }),
  }).then(r => r.json()).then(d => console.log('📱 WhatsApp sent:', JSON.stringify(d))).catch(err => console.error('❌ WhatsApp error:', err.message));
}

async function sendCancellationNotifications({ orderId, productName, amount, quantity, address, paymentMethod, orderDate }) {
  const requestedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name = address?.name || 'Customer';
  const phone = address?.phone || 'N/A';
  const fullAddress = address ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}` : 'Not provided';
  resend.emails.send({
    from: 'GiftKart Orders <onboarding@resend.dev>',
    to: 'malikaafan50@gmail.com',
    subject: `🚫 Cancellation Request — ${orderId} | ${productName}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:linear-gradient(135deg,#e53935,#c62828);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0"><h1 style="margin:0">🚫 Cancellation Request</h1><p>Order ID: <strong>${orderId}</strong></p><p>${requestedAt}</p></div><div style="background:#f9f9f9;padding:24px"><p><b>Product:</b> ${productName}</p><p><b>Quantity:</b> ${quantity}</p><p><b>Amount:</b> ₹${amount}</p><p><b>Payment:</b> ${paymentMethod}</p><p><b>Order Date:</b> ${orderDate}</p><p><b>Name:</b> ${name}</p><p><b>Phone:</b> +91 ${phone}</p><p><b>Address:</b> ${fullAddress}</p></div></div>`,
  }).then(() => console.log('📧 Cancellation email sent!')).catch(err => console.error('❌ Email error:', err.message));

  const waBody = `🚫 *Cancellation Request — GiftKart*\n\n📋 *Order ID:* ${orderId}\n📦 *Product:* ${productName}\n💰 *Amount:* ₹${amount}\n💳 *Payment:* ${paymentMethod}\n📅 *Order Date:* ${orderDate}\n\n👤 *Customer:* ${name}\n📞 +91 ${phone}\n📍 ${fullAddress}\n\n⚠️ Please process within 24 hours.`;
  fetch('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
    body: JSON.stringify({ integrated_number: '917889677109', content_type: 'template', payload: { to: '917889677109', type: 'text', text: { body: waBody } } }),
  }).then(r => r.json()).then(d => console.log('📱 Cancellation WhatsApp sent:', JSON.stringify(d))).catch(err => console.error('❌ WhatsApp error:', err.message));
}

app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;
    if (!amount || typeof amount !== 'number' || amount < 100) return res.status(400).json({ error: 'Invalid amount.' });
    const order = await razorpay.orders.create({ amount: Math.round(amount), currency, receipt: `receipt_${Date.now()}`, notes: { product_name: product_name || 'GiftKart Product' } });
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, key_id: 'rzp_test_SgBnUHFf2EeuVz' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const { payment_id, order_id, signature, product_name, amount, quantity, address, photo_base64, custom_details } = req.body;
    if (!payment_id || !order_id || !signature) return res.status(400).json({ error: 'Missing required fields' });
    const expected = crypto.createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn').update(`${order_id}|${payment_id}`).digest('hex');
    if (expected !== signature) return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    const orderId = `GK${Date.now()}`;
    res.json({ success: true, order_id: orderId, payment_id });
    setImmediate(() => sendNotifications({ orderId, productName: product_name || 'GiftKart Product', amount: amount || 0, quantity: quantity || 1, address: address || {}, paymentMethod: 'Online Payment (Razorpay)', paymentId: payment_id, photoBase64: photo_base64 || null, customDetails: custom_details || null }));
  } catch (error) {
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

app.post('/cod-order', async (req, res) => {
  try {
    const { product_name, amount, quantity, address, photo_base64, custom_details } = req.body;
    if (!product_name || !amount) return res.status(400).json({ error: 'Missing required fields' });
    const orderId = `GK${Date.now()}`;
    res.json({ success: true, order_id: orderId });
    setImmediate(() => sendNotifications({ orderId, productName: product_name, amount, quantity: quantity || 1, address: address || {}, paymentMethod: 'Cash on Delivery', paymentId: null, photoBase64: photo_base64 || null, customDetails: custom_details || null }));
  } catch (error) {
    res.status(500).json({ error: 'COD order error', details: error.message });
  }
});

app.post('/cancel-order', async (req, res) => {
  try {
    const { order_id, product_name, amount, quantity, payment_method, order_date, address } = req.body;
    if (!order_id || !product_name) return res.status(400).json({ error: 'Missing required fields' });
    res.json({ success: true, order_id });
    setImmediate(() => sendCancellationNotifications({ orderId: order_id, productName: product_name, amount: amount || 0, quantity: quantity || 1, paymentMethod: payment_method || 'N/A', orderDate: order_date || 'N/A', address: address || {} }));
  } catch (error) {
    res.status(500).json({ error: 'Cancellation error', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 GiftKart Server v8 on port ${PORT}`));
