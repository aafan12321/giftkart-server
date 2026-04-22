const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ─── Razorpay ────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: 'rzp_test_SgBnUHFf2EeuVz',
  key_secret: '443AtQ4Dsg9D1afcspfORkzn',
});

// ─── Nodemailer (Gmail) ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'malikaafan50@gmail.com',
    pass: 'vpql ywim jfyb alzy',   // Gmail App Password
  },
});

// ─── Twilio WhatsApp ──────────────────────────────────────────────────────────
const twilioClient = twilio(
  'AC0df2b98e0508cbdb83774ca207abcc79',
  '8dc831bd39ab6b3105b966e8ef2010d4'
);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GiftKart Payment Server running ✅' });
});

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, currency = 'INR' } = req.body;

    if (!amount || typeof amount !== 'number' || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }

    const options = {
      amount: Math.round(amount),
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: { product_name: product_name || 'GiftKart Product' },
    };

    const order = await razorpay.orders.create(options);
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

// ─── VERIFY PAYMENT + SEND EMAIL + WHATSAPP ───────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    const {
      payment_id,
      order_id,
      signature,
      // Order details from Flutter
      product_name,
      amount,
      quantity,
      address,
      payment_method,
    } = req.body;

    if (!payment_id || !order_id || !signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ── Verify Razorpay signature ─────────────────────────────────────────────
    const body = `${order_id}|${payment_id}`;
    const expected_signature = crypto
      .createHmac('sha256', '443AtQ4Dsg9D1afcspfORkzn')
      .update(body)
      .digest('hex');

    const isValid = expected_signature === signature;

    if (!isValid) {
      console.warn(`❌ Signature mismatch for order ${order_id}`);
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    }

    console.log(`✅ Payment verified: ${payment_id}`);

    // ── Build order details ───────────────────────────────────────────────────
    const orderId = `GK${Date.now()}`;
    const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const totalAmount = amount || 0;
    const name = address?.name || 'Customer';
    const phone = address?.phone || '';
    const fullAddress = address
      ? `${address.house}, ${address.area}, ${address.city} - ${address.pincode}`
      : 'Not provided';

    // ── Send Email ────────────────────────────────────────────────────────────
    try {
      await transporter.sendMail({
        from: '"GiftKart Orders 🎁" <malikaafan50@gmail.com>',
        to: 'malikaafan50@gmail.com',
        subject: `🎁 New Order Received! - ${orderId}`,
        html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
    .box { background: white; padding: 20px; margin: 16px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.08); }
    .label { font-weight: bold; color: #667eea; }
    .total { font-size: 26px; font-weight: bold; color: #4CAF50; text-align: center; padding: 16px; }
    .badge { display: inline-block; background: #4CAF50; color: white; padding: 4px 12px; border-radius: 20px; font-size: 13px; }
    .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1 style="margin:0">🎁 New Order Received!</h1>
    <p style="margin:8px 0 0">Order ID: <strong>${orderId}</strong></p>
    <p style="margin:4px 0 0;font-size:14px">${orderDate}</p>
  </div>
  <div class="content">

    <div class="box">
      <h2 style="margin-top:0;color:#667eea">📦 Order Details</h2>
      <p><span class="label">Product:</span> ${product_name || 'GiftKart Product'}</p>
      <p><span class="label">Quantity:</span> ${quantity || 1}</p>
      <p><span class="label">Payment ID:</span> ${payment_id}</p>
      <p><span class="label">Razorpay Order ID:</span> ${order_id}</p>
      <p><span class="label">Payment Method:</span> ${payment_method || 'Razorpay'}</p>
      <p><span class="label">Status:</span> <span class="badge">✅ PAID</span></p>
    </div>

    <div class="total">💰 Total Paid: ₹${totalAmount}</div>

    <div class="box">
      <h2 style="margin-top:0;color:#667eea">📍 Delivery Address</h2>
      <p><span class="label">Name:</span> ${name}</p>
      <p><span class="label">Phone:</span> +91 ${phone}</p>
      <p><span class="label">Address:</span> ${fullAddress}</p>
    </div>

    <div class="footer">
      <p>GiftKart Automated Order Notification</p>
      <p>${orderDate}</p>
    </div>
  </div>
</div>
</body>
</html>
        `,
      });
      console.log('📧 Order email sent!');
    } catch (emailError) {
      console.error('❌ Email error:', emailError.message);
      // Don't fail the whole request if email fails
    }

    // ── Send WhatsApp ─────────────────────────────────────────────────────────
    try {
      const whatsappMsg =
`🎁 *New GiftKart Order!*

📋 *Order ID:* ${orderId}
📅 *Date:* ${orderDate}

📦 *Product:* ${product_name || 'GiftKart Product'}
🔢 *Quantity:* ${quantity || 1}
💰 *Amount Paid:* ₹${totalAmount}
✅ *Status:* PAID

👤 *Customer:* ${name}
📞 *Phone:* +91 ${phone}
📍 *Address:* ${fullAddress}

💳 *Payment ID:* ${payment_id}
🔖 *Order ID:* ${order_id}`;

      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: 'whatsapp:+917889677109',
        body: whatsappMsg,
      });
      console.log('📱 WhatsApp notification sent!');
    } catch (waError) {
      console.error('❌ WhatsApp error:', waError.message);
      // Don't fail the whole request if WhatsApp fails
    }

    // ── Return success ────────────────────────────────────────────────────────
    res.json({
      success: true,
      message: 'Payment verified successfully',
      order_id: orderId,
      payment_id,
      razorpay_order_id: order_id,
    });

  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(500).json({ error: 'Verification error', details: error.message });
  }
});

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GiftKart Server running on port ${PORT}`);
  console.log(`   POST /create-order   — Create Razorpay order`);
  console.log(`   POST /verify-payment — Verify + Email + WhatsApp`);
});
