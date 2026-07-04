const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const { Resend } = require('resend');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ── Secrets from environment variables ────────────────────────────────────────
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RESEND_API_KEY      = process.env.RESEND_API_KEY;
const MSG91_AUTH_KEY      = process.env.MSG91_AUTH_KEY;
const NOTIFY_EMAIL        = process.env.NOTIFY_EMAIL;
const WHATSAPP_NUMBER     = process.env.WHATSAPP_NUMBER;
const FROM_EMAIL          = process.env.FROM_EMAIL;

const razorpay = new Razorpay({
  key_id:     RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

const resend = new Resend(RESEND_API_KEY);

app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Server v9 ✅' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCustomHtml(customDetails) {
  if (!customDetails) return '';
  const labels = {
    customerName:    'Customer Name',
    calligraphyText: 'Calligraphy Text',
    designText:      'Design Text',
    fontStyle:       'Font Style',
    frameType:       'Frame Type',
    cupColor:        'Cup Color',
    size:            'Size',
    specialNotes:    'Special Notes',
  };
  let html = '<hr style="margin:15px 0"><h3 style="color:#667eea">🎨 Customization</h3>';
  for (const [key, label] of Object.entries(labels)) {
    if (customDetails[key]) html += `<p><b>${label}:</b> ${customDetails[key]}</p>`;
  }
  return html;
}

// Coerce anything into a safe number instead of letting NaN/undefined reach
// the email/Firestore. Never throws.
function safeNum(value, fallback = 0) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && !Number.isNaN(n) ? n : fallback;
}

// Builds the itemized "one block per product" HTML used when an order
// contains a `products` array (multi-item cart checkout), instead of the
// single merged "N items from GiftKart" line.
function buildProductsHtml(products) {
  return products.map((p) => {
    const name     = p?.name || 'Product';
    const price    = safeNum(p?.price, 0);
    const quantity = safeNum(p?.quantity, 1);
    const subtotal = safeNum(p?.subtotal, price * quantity);
    return `
      <div style="border-bottom:1px solid #eee;padding:15px 0">
        <p><b>Product:</b> ${name}</p>
        <p><b>Quantity:</b> ${quantity}</p>
        <p><b>Unit Price:</b> ₹${price}</p>
        <p><b>Subtotal:</b> ₹${subtotal}</p>
        ${buildCustomHtml(p?.details || p?.customDetails)}
      </div>`;
  }).join('');
}

async function sendNotifications({
  orderId, productName, amount, quantity,
  address, paymentMethod, paymentId,
  photoBase64, customDetails, products,
}) {
  const orderDate   = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name        = address?.name  || 'Customer';
  const phone       = address?.phone || 'N/A';
  const fullAddress = address
    ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}`
    : 'Not provided';

  const attachments = [];
  let photoHtml = '';
  if (photoBase64) {
    attachments.push({ filename: 'customer_photo.jpg', content: photoBase64 });
    photoHtml = `<div style="text-align:center"><img src="data:image/jpeg;base64,${photoBase64}" style="max-width:100%;max-height:400px;border-radius:10px"/></div>`;
  }

  // Multi-product orders: list every product individually instead of a
  // single merged line. Falls back to the legacy single-product block when
  // no `products` array was sent (older app builds, single-item checkout).
  const hasProducts = Array.isArray(products) && products.length > 0;
  const productsBlockHtml = hasProducts
    ? `<p><b>${products.length} item${products.length === 1 ? '' : 's'} in this order:</b></p>${buildProductsHtml(products)}`
    : `<p><b>Product:</b> ${productName}</p>
       <p><b>Quantity:</b> ${quantity}</p>
       ${buildCustomHtml(customDetails)}`;

  try {
    await resend.emails.send({
      from:        FROM_EMAIL,
      to:          NOTIFY_EMAIL,
      subject:     `🎁 New Order - ${orderId} | ₹${amount} | ${hasProducts ? `${products.length} items` : productName}`,
      attachments,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="margin:0">🎁 New Order!</h1>
          <p>Order ID: <strong>${orderId}</strong></p>
          <p>${orderDate}</p>
        </div>
        <div style="background:#f9f9f9;padding:24px">
          ${productsBlockHtml}
          <p><b>Payment:</b> ${paymentMethod}</p>
          ${paymentId ? `<p><b>Payment ID:</b> ${paymentId}</p>` : ''}
          ${photoHtml}
          <p style="font-size:24px;color:#4CAF50;text-align:center">💰 Grand Total: ₹${amount}</p>
          <p><b>Name:</b> ${name}</p>
          <p><b>Phone:</b> +91 ${phone}</p>
          <p><b>Address:</b> ${fullAddress}</p>
        </div>
      </div>`,
    });
    console.log('📧 Email sent!');
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

async function sendCancellationNotifications({
  orderId, productName, amount, quantity,
  address, paymentMethod, orderDate,
}) {
  const requestedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const name        = address?.name  || 'Customer';
  const phone       = address?.phone || 'N/A';
  const fullAddress = address
    ? `${address.house || ''}, ${address.area || ''}, ${address.city || ''} - ${address.pincode || ''}`
    : 'Not provided';

  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      NOTIFY_EMAIL,
      subject: `🚫 Cancellation Request — ${orderId} | ${productName}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#e53935,#c62828);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="margin:0">🚫 Cancellation Request</h1>
          <p>Order ID: <strong>${orderId}</strong></p>
          <p>${requestedAt}</p>
        </div>
        <div style="background:#f9f9f9;padding:24px">
          <p><b>Product:</b> ${productName}</p>
          <p><b>Quantity:</b> ${quantity}</p>
          <p><b>Amount:</b> ₹${amount}</p>
          <p><b>Payment:</b> ${paymentMethod}</p>
          <p><b>Order Date:</b> ${orderDate}</p>
          <p><b>Name:</b> ${name}</p>
          <p><b>Phone:</b> +91 ${phone}</p>
          <p><b>Address:</b> ${fullAddress}</p>
        </div>
      </div>`,
    });
    console.log('📧 Cancellation email sent!');
  } catch (err) {
    console.error('❌ Cancellation email error:', err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;
    if (!amount || typeof amount !== 'number' || amount < 100)
      return res.status(400).json({ error: 'Invalid amount.' });
    const order = await razorpay.orders.create({
      amount:   Math.round(amount),
      currency,
      receipt:  `receipt_${Date.now()}`,
      notes:    { product_name: product_name || 'GiftKart Product' },
    });
    res.json({
      success:  true,
      order_id: order.id,
      amount:   order.amount,
      currency: order.currency,
      key_id:   RAZORPAY_KEY_ID,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const {
      payment_id, order_id, signature, product_name, amount, quantity,
      address, photo_base64, custom_details, products,
    } = req.body;
    if (!payment_id || !order_id || !signature)
      return res.status(400).json({ error: 'Missing required fields' });

    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${order_id}|${payment_id}`)
      .digest('hex');

    if (expected !== signature)
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });

    const orderId = `GK${Date.now()}`;
    res.json({ success: true, order_id: orderId, payment_id });

    setImmediate(() => sendNotifications({
      orderId,
      productName:   product_name  || 'GiftKart Product',
      amount:        amount         || 0,
      quantity:      quantity       || 1,
      address:       address        || {},
      paymentMethod: 'Online Payment (Razorpay)',
      paymentId:     payment_id,
      photoBase64:   photo_base64   || null,
      customDetails: custom_details || null,
      // NEW: complete cart, when the client sends it — every purchased
      // product, each with its own name/price/quantity/subtotal. Nothing
      // is discarded to a single merged "N items" line anymore.
      products:      Array.isArray(products) ? products : null,
    }));
  } catch (error) {
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

app.post('/cod-order', async (req, res) => {
  try {
    const { product_name, amount, quantity, address, photo_base64, custom_details, products } = req.body;
    if (!product_name || !amount)
      return res.status(400).json({ error: 'Missing required fields' });
    const orderId = `GK${Date.now()}`;
    res.json({ success: true, order_id: orderId });
    setImmediate(() => sendNotifications({
      orderId,
      productName:   product_name,
      amount,
      quantity:      quantity       || 1,
      address:       address        || {},
      paymentMethod: 'Cash on Delivery',
      paymentId:     null,
      photoBase64:   photo_base64   || null,
      customDetails: custom_details || null,
      products:      Array.isArray(products) ? products : null,
    }));
  } catch (error) {
    res.status(500).json({ error: 'COD order error', details: error.message });
  }
});

app.post('/cancel-order', async (req, res) => {
  try {
    const { order_id, product_name, amount, quantity, payment_method, order_date, address } = req.body;
    if (!order_id || !product_name)
      return res.status(400).json({ error: 'Missing required fields' });
    res.json({ success: true, order_id });
    setImmediate(() => sendCancellationNotifications({
      orderId:       order_id,
      productName:   product_name,
      amount:        amount         || 0,
      quantity:      quantity       || 1,
      paymentMethod: payment_method || 'N/A',
      orderDate:     order_date     || 'N/A',
      address:       address        || {},
    }));
  } catch (error) {
    res.status(500).json({ error: 'Cancellation error', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 GiftKart Server v9 on port ${PORT}`));
