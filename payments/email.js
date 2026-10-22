'use strict';
const { esc, safeNum, optimizeCloudinary } = require('./ids');

function buildCustomHtml(c) {
  if (!c) return '';
  const labels = {
    customerName: 'Customer Name', calligraphyText: 'Calligraphy Text', designText: 'Design Text',
    fontStyle: 'Font Style', frameType: 'Frame Type', cupColor: 'Cup Color', size: 'Size',
    specialNotes: 'Special Notes',
  };
  let html = '<hr style="margin:15px 0"><h3 style="color:#667eea">🎨 Customization</h3>';
  for (const [key, label] of Object.entries(labels)) {
    if (c[key]) html += `<p><b>${label}:</b> ${esc(c[key])}</p>`;
  }
  if (typeof c.photoUrl === 'string' && c.photoUrl.startsWith('https://')) {
    html += `<p><b>Customer photo:</b> <a href="${esc(c.photoUrl)}">open original</a></p>`
      + `<div style="text-align:center"><img src="${esc(optimizeCloudinary(c.photoUrl, 800))}" style="max-width:100%;max-height:400px;border-radius:10px"/></div>`;
  }
  return html;
}

function buildProductsHtml(products) {
  return products.map((p) => {
    const price = safeNum(p && p.price, 0);
    const quantity = safeNum(p && p.quantity, 1);
    const subtotal = safeNum(p && p.subtotal, price * quantity);
    return `
      <div style="border-bottom:1px solid #eee;padding:15px 0">
        <p><b>Product:</b> ${esc((p && p.name) || 'Product')}</p>
        <p><b>Quantity:</b> ${quantity}</p>
        <p><b>Unit Price:</b> ₹${price}</p>
        <p><b>Subtotal:</b> ₹${subtotal}</p>
        ${buildCustomHtml((p && (p.details || p.customDetails)) || null)}
      </div>`;
  }).join('');
}

function createMailer({ resend, from, to, alertTo, logger = console }) {
  async function send(payload) {
    try {
      if (!resend || !from || !payload.to) { logger.error('❌ Email not configured'); return false; }
      const r = await resend.emails.send({ from, ...payload });
      if (r && r.error) { logger.error('❌ Email error:', r.error.message || r.error); return false; }
      return true;
    } catch (err) {
      logger.error('❌ Email error:', err && err.message);
      return false;
    }
  }

  // d: { orderId, productName, amount(₹ paid), quantity, address, paymentMethod,
  //      paymentId, photoBase64, customDetails, products, referralDiscount,
  //      banners:[string], contact, email }
  async function sendOrderEmail(d) {
    const orderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const a = d.address || {};
    const fullAddress = d.address
      ? `${a.house || ''}, ${a.area || ''}, ${a.city || ''} - ${a.pincode || ''}`
      : 'Not provided';
    const attachments = [];
    let photoHtml = '';
    if (d.photoBase64) {
      attachments.push({ filename: 'customer_photo.jpg', content: d.photoBase64 });
      photoHtml = `<div style="text-align:center"><img src="data:image/jpeg;base64,${d.photoBase64}" style="max-width:100%;max-height:400px;border-radius:10px"/></div>`;
    }
    const hasProducts = Array.isArray(d.products) && d.products.length > 0;
    const productsBlock = hasProducts
      ? `<p><b>${d.products.length} item${d.products.length === 1 ? '' : 's'} in this order:</b></p>${buildProductsHtml(d.products)}`
      : `<p><b>Product:</b> ${esc(d.productName)}</p><p><b>Quantity:</b> ${esc(d.quantity)}</p>${buildCustomHtml(d.customDetails)}`;
    const refHtml = d.referralDiscount > 0
      ? `<p><b>Referral discount:</b> −₹${esc(d.referralDiscount)} (first order)</p>` : '';
    const banners = (d.banners || []).map((b) =>
      `<div style="background:#fff3cd;border:1px solid #ffe08a;padding:12px;margin-bottom:12px;border-radius:8px"><b>⚠ ${esc(b)}</b></div>`).join('');
    const subjTag = (d.banners && d.banners.length) ? '⚠ ' : '';
    return send({
      to: to,
      subject: `${subjTag}🎁 New Order - ${d.orderId} | ₹${d.amount} | ${hasProducts ? `${d.products.length} items` : d.productName}`,
      attachments,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="margin:0">🎁 New Order!</h1>
          <p>Order ID: <strong>${esc(d.orderId)}</strong></p><p>${orderDate}</p>
        </div>
        <div style="background:#f9f9f9;padding:24px">
          ${banners}${productsBlock}
          <p><b>Payment:</b> ${esc(d.paymentMethod)}</p>
          ${d.paymentId ? `<p><b>Payment ID:</b> ${esc(d.paymentId)}</p>` : ''}
          ${refHtml}${photoHtml}
          <p style="font-size:24px;color:#4CAF50;text-align:center">💰 Grand Total: ₹${esc(d.amount)}</p>
          <p><b>Name:</b> ${esc(a.name || 'Customer')}</p>
          <p><b>Phone:</b> +91 ${esc(a.phone || 'N/A')}</p>
          ${d.contact ? `<p><b>Razorpay contact:</b> ${esc(d.contact)} ${d.email ? '· ' + esc(d.email) : ''}</p>` : ''}
          <p><b>Address:</b> ${esc(fullAddress)}</p>
        </div></div>`,
    });
  }

  async function sendCancellation(d) {
    const requestedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const a = d.address || {};
    const fullAddress = d.address ? `${a.house || ''}, ${a.area || ''}, ${a.city || ''} - ${a.pincode || ''}` : 'Not provided';
    return send({
      to,
      subject: `🚫 Cancellation Request — ${d.orderId} | ${d.productName}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#e53935,#c62828);color:white;padding:30px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="margin:0">🚫 Cancellation Request</h1><p>Order ID: <strong>${esc(d.orderId)}</strong></p><p>${requestedAt}</p></div>
        <div style="background:#f9f9f9;padding:24px">
          <p><b>Product:</b> ${esc(d.productName)}</p><p><b>Quantity:</b> ${esc(d.quantity)}</p>
          <p><b>Amount:</b> ₹${esc(d.amount)}</p><p><b>Payment:</b> ${esc(d.paymentMethod)}</p>
          <p><b>Order Date:</b> ${esc(d.orderDate)}</p><p><b>Name:</b> ${esc(a.name || 'Customer')}</p>
          <p><b>Phone:</b> +91 ${esc(a.phone || 'N/A')}</p><p><b>Address:</b> ${esc(fullAddress)}</p>
        </div></div>`,
    });
  }

  async function sendAlert(subject, bodyHtml) {
    return send({ to: alertTo || to, subject: `🚨 GiftKart: ${subject}`, html: `<div style="font-family:Arial,sans-serif;max-width:640px">${bodyHtml}</div>` });
  }

  async function sendPhoto({ orderId, photoBase64 }) {
    return send({
      to, subject: `📷 Customer photo for order ${orderId}`,
      attachments: [{ filename: 'customer_photo.jpg', content: photoBase64 }],
      html: `<p>Customer photo for order <b>${esc(orderId)}</b> is attached.</p>`,
    });
  }

  return { sendOrderEmail, sendCancellation, sendAlert, sendPhoto };
}
module.exports = { createMailer, buildCustomHtml, buildProductsHtml };
