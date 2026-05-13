const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static('public'));
app.use('/pdfs', express.static('pdfs'));

// ==================== CONFIG ====================
const CONFIG = {
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || 'YOUR_LINE_CHANNEL_SECRET',
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'YOUR_LINE_ACCESS_TOKEN',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || 'YOUR_GOOGLE_SHEET_ID',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY || '',
  COMPANY: {
    name: 'บริษัท ยูนิคอน คอนเทนเนอร์ เซอร์วิสเซส จำกัด',
    nameEn: 'Unicon Container Services Co., Ltd.',
    address: '123 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110',
    taxId: '0105565XXXXXX',
    tel: '02-XXX-XXXX',
    email: 'info@uniconcontainer.com',
  },
};

// ==================== IN-MEMORY STORE ====================
// In production, replace with a real database (MongoDB, PostgreSQL, etc.)
const sessions = {};  // userId -> sessionData
const invoices = {};  // invoiceId -> invoiceData

// ==================== UTILITIES ====================
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function getInvoiceNumber() {
  const date = new Date();
  const year = date.getFullYear() + 543; // Buddhist era
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const count = Object.keys(invoices).length + 1;
  return `IV${year}${month}${String(count).padStart(4, '0')}`;
}

function verifyLineSignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', CONFIG.LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// ==================== LINE MESSAGING API ====================
async function sendLineMessage(userId, messages) {
  const body = {
    to: userId,
    messages: Array.isArray(messages) ? messages : [messages],
  };
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error('LINE API Error:', data);
  return data;
}

async function replyLineMessage(replyToken, messages) {
  const body = {
    replyToken,
    messages: Array.isArray(messages) ? messages : [messages],
  };
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error('LINE Reply Error:', data);
  return data;
}

// ==================== LINE WEBHOOK ====================
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifyLineSignature(req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ status: 'ok' });

  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleLineEvent(event);
    } catch (err) {
      console.error('Event handling error:', err);
    }
  }
});

async function handleLineEvent(event) {
  const userId = event.source?.userId;

  // เมื่อผู้ใช้เพิ่มเพื่อน หรือ unblock
  if (event.type === 'follow') {
    await sendWelcomeMessage(userId);
    return;
  }

  if (event.type !== 'message' || event.message?.type !== 'text') return;

  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // คำสั่งสำหรับขอใบกำกับภาษี
  if (
    text.includes('ใบกำกับภาษี') ||
    text.includes('invoice') ||
    text.toLowerCase().includes('tax invoice') ||
    text === 'ขอใบกำกับภาษี'
  ) {
    await handleRequestInvoice(userId, replyToken);
  }
}

async function sendWelcomeMessage(userId) {
  await sendLineMessage(userId, [
    {
      type: 'text',
      text: `🏢 ยินดีต้อนรับสู่ Unicon Container Services!\n\nบริษัท ยูนิคอน คอนเทนเนอร์ เซอร์วิสเซส จำกัด ยินดีให้บริการครับ\n\nพิมพ์ "ขอใบกำกับภาษี" เพื่อเริ่มต้นขอรับใบกำกับภาษีแบบเต็มได้เลยครับ 📄`,
    },
    {
      type: 'flex',
      altText: 'เมนูบริการ',
      contents: {
        type: 'bubble',
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '🚢',
              size: '5xl',
              align: 'center',
              margin: 'md',
            },
            {
              type: 'text',
              text: 'Unicon Container Services',
              weight: 'bold',
              size: 'lg',
              align: 'center',
              color: '#1a3a5c',
            },
          ],
          backgroundColor: '#e8f4fd',
          paddingAll: 'xl',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: 'บริการของเรา',
              weight: 'bold',
              size: 'md',
              color: '#333333',
            },
            {
              type: 'separator',
              margin: 'md',
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'md',
              spacing: 'sm',
              contents: [
                {
                  type: 'text',
                  text: '📄 ออกใบกำกับภาษีแบบเต็ม',
                  size: 'sm',
                  color: '#555555',
                },
                {
                  type: 'text',
                  text: '📥 ดาวน์โหลด PDF ทันที',
                  size: 'sm',
                  color: '#555555',
                },
              ],
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#1a3a5c',
              action: {
                type: 'message',
                label: '📄 ขอใบกำกับภาษี',
                text: 'ขอใบกำกับภาษี',
              },
            },
          ],
        },
      },
    },
  ]);
}

async function handleRequestInvoice(userId, replyToken) {
  const sessionId = generateId();
  sessions[userId] = { sessionId, createdAt: new Date() };

  const formUrl = `${CONFIG.BASE_URL}/form?session=${sessionId}&user=${userId}`;

  await replyLineMessage(replyToken, [
    {
      type: 'flex',
      altText: 'กรอกข้อมูลใบกำกับภาษี',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '📄 ขอใบกำกับภาษีแบบเต็ม',
              weight: 'bold',
              size: 'lg',
              color: '#1a3a5c',
            },
            {
              type: 'separator',
              margin: 'md',
            },
            {
              type: 'text',
              text: 'กรุณากรอกข้อมูลของท่านในแบบฟอร์มออนไลน์ เพื่อออกใบกำกับภาษีแบบเต็ม',
              wrap: true,
              size: 'sm',
              color: '#666666',
              margin: 'md',
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              spacing: 'sm',
              contents: [
                { type: 'text', text: '✅ ข้อมูลผู้ซื้อ/บริษัท', size: 'sm', color: '#444' },
                { type: 'text', text: '✅ รายการสินค้า/บริการ', size: 'sm', color: '#444' },
                { type: 'text', text: '✅ ดาวน์โหลด PDF ทันที', size: 'sm', color: '#444' },
              ],
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#1a3a5c',
              action: {
                type: 'uri',
                label: '📝 กรอกข้อมูลที่นี่',
                uri: formUrl,
              },
            },
            {
              type: 'text',
              text: 'ลิงก์นี้ใช้ได้ 24 ชั่วโมง',
              size: 'xs',
              align: 'center',
              color: '#999999',
              margin: 'sm',
            },
          ],
        },
      },
    },
  ]);
}

// ==================== PDF GENERATION ====================
async function generateInvoicePDF(invoiceData) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();

  // Load fonts
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Colors
  const darkBlue = rgb(0.1, 0.227, 0.361);
  const lightBlue = rgb(0.906, 0.953, 0.992);
  const gray = rgb(0.4, 0.4, 0.4);
  const black = rgb(0, 0, 0);
  const white = rgb(1, 1, 1);

  // ── Header background ──
  page.drawRectangle({
    x: 0, y: height - 130,
    width, height: 130,
    color: darkBlue,
  });

  // Company name
  page.drawText('UNICON CONTAINER SERVICES', {
    x: 30, y: height - 45,
    size: 18, font: helveticaBold, color: white,
  });
  page.drawText('Unicon Container Services Co., Ltd.', {
    x: 30, y: height - 65,
    size: 9, font: helvetica, color: rgb(0.7, 0.85, 1),
  });
  page.drawText(CONFIG.COMPANY.address, {
    x: 30, y: height - 82,
    size: 7.5, font: helvetica, color: rgb(0.7, 0.85, 1),
  });
  page.drawText(`เลขประจำตัวผู้เสียภาษี: ${CONFIG.COMPANY.taxId}  โทร: ${CONFIG.COMPANY.tel}`, {
    x: 30, y: height - 97,
    size: 7.5, font: helvetica, color: rgb(0.7, 0.85, 1),
  });

  // Invoice title (right)
  page.drawText('TAX INVOICE', {
    x: width - 180, y: height - 40,
    size: 20, font: helveticaBold, color: white,
  });
  page.drawText('INVOICE', {
    x: width - 152, y: height - 57,
    size: 9, font: helvetica, color: rgb(0.7, 0.85, 1),
  });

  // Invoice details box
  const detailBoxY = height - 130;
  page.drawRectangle({
    x: width - 200, y: detailBoxY - 70,
    width: 170, height: 70,
    color: lightBlue,
    borderColor: rgb(0.8, 0.9, 1),
    borderWidth: 1,
  });

  const drawDetailRow = (label, value, y) => {
    page.drawText(label, { x: width - 195, y, size: 8, font: helveticaBold, color: darkBlue });
    page.drawText(value, { x: width - 120, y, size: 8, font: helvetica, color: black });
  };

  drawDetailRow('เลขที่:', invoiceData.invoiceNumber, detailBoxY - 20);
  drawDetailRow('วันที่:', invoiceData.date, detailBoxY - 35);
  drawDetailRow('ครบกำหนด:', invoiceData.dueDate || invoiceData.date, detailBoxY - 50);
  drawDetailRow('สกุลเงิน:', 'THB (บาท)', detailBoxY - 65);

  // ── Bill To section ──
  const billY = height - 215;
  page.drawText('ข้อมูลผู้ซื้อ / BILL TO', {
    x: 30, y: billY + 15,
    size: 8.5, font: helveticaBold, color: darkBlue,
  });
  page.drawLine({ start: { x: 30, y: billY + 10 }, end: { x: 260, y: billY + 10 }, thickness: 1, color: darkBlue });

  page.drawText(invoiceData.customerName, { x: 30, y: billY - 5, size: 10, font: helveticaBold, color: black });
  page.drawText(invoiceData.customerAddress, { x: 30, y: billY - 20, size: 8, font: helvetica, color: gray, maxWidth: 230 });
  page.drawText(`เลขประจำตัวผู้เสียภาษี: ${invoiceData.customerTaxId}`, { x: 30, y: billY - 35, size: 8, font: helvetica, color: gray });
  if (invoiceData.customerBranch) {
    page.drawText(`สาขา: ${invoiceData.customerBranch}`, { x: 30, y: billY - 50, size: 8, font: helvetica, color: gray });
  }

  // ── Items Table ──
  const tableY = height - 310;
  const colX = [30, 250, 330, 400, 470, 540];

  // Table header
  page.drawRectangle({ x: 25, y: tableY, width: width - 50, height: 22, color: darkBlue });
  const headers = ['รายการ / Description', 'จำนวน', 'หน่วย', 'ราคา/หน่วย', 'ส่วนลด', 'จำนวนเงิน'];
  headers.forEach((h, i) => {
    page.drawText(h, { x: colX[i] + 3, y: tableY + 7, size: 7.5, font: helveticaBold, color: white });
  });

  // Table rows
  let rowY = tableY - 2;
  const items = invoiceData.items || [];
  items.forEach((item, idx) => {
    rowY -= 22;
    if (idx % 2 === 0) {
      page.drawRectangle({ x: 25, y: rowY, width: width - 50, height: 22, color: rgb(0.97, 0.98, 1) });
    }
    page.drawText(item.description, { x: colX[0] + 3, y: rowY + 7, size: 8, font: helvetica, color: black, maxWidth: 215 });
    page.drawText(String(item.qty), { x: colX[1] + 3, y: rowY + 7, size: 8, font: helvetica, color: black });
    page.drawText(item.unit || 'ครั้ง', { x: colX[2] + 3, y: rowY + 7, size: 8, font: helvetica, color: black });
    page.drawText(formatNumber(item.unitPrice), { x: colX[3] + 3, y: rowY + 7, size: 8, font: helvetica, color: black });
    page.drawText(formatNumber(item.discount || 0), { x: colX[4] + 3, y: rowY + 7, size: 8, font: helvetica, color: black });
    page.drawText(formatNumber(item.amount), { x: colX[5] + 3, y: rowY + 7, size: 8, font: helvetica, color: black });

    // Row border
    page.drawLine({ start: { x: 25, y: rowY }, end: { x: width - 25, y: rowY }, thickness: 0.3, color: rgb(0.85, 0.9, 0.95) });
  });

  // ── Totals ──
  const summaryX = width - 200;
  let summaryY = rowY - 30;

  const subtotal = invoiceData.subtotal || 0;
  const discount = invoiceData.totalDiscount || 0;
  const vatBase = subtotal - discount;
  const vat = invoiceData.vat || vatBase * 0.07;
  const total = invoiceData.total || vatBase + vat;

  const drawSummaryRow = (label, value, isBold = false, isHighlight = false) => {
    if (isHighlight) {
      page.drawRectangle({ x: summaryX - 10, y: summaryY - 4, width: 185, height: 18, color: darkBlue });
      page.drawText(label, { x: summaryX, y: summaryY, size: 9, font: helveticaBold, color: white });
      page.drawText(value, { x: summaryX + 100, y: summaryY, size: 9, font: helveticaBold, color: white });
    } else {
      page.drawText(label, { x: summaryX, y: summaryY, size: 8.5, font: isBold ? helveticaBold : helvetica, color: isBold ? darkBlue : gray });
      page.drawText(value, { x: summaryX + 100, y: summaryY, size: 8.5, font: isBold ? helveticaBold : helvetica, color: black });
    }
    summaryY -= 20;
  };

  drawSummaryRow('ยอดรวมก่อนหักส่วนลด:', `${formatNumber(subtotal)} บาท`);
  drawSummaryRow('ส่วนลด:', `${formatNumber(discount)} บาท`);
  drawSummaryRow('ราคาก่อนภาษี:', `${formatNumber(vatBase)} บาท`, true);
  drawSummaryRow('ภาษีมูลค่าเพิ่ม (7%):', `${formatNumber(vat)} บาท`);
  summaryY -= 5;
  drawSummaryRow('ยอดรวมทั้งสิ้น:', `${formatNumber(total)} บาท`, false, true);

  // ── Notes ──
  if (invoiceData.notes) {
    const noteY = summaryY - 30;
    page.drawText('หมายเหตุ / Notes:', { x: 30, y: noteY + 15, size: 8, font: helveticaBold, color: darkBlue });
    page.drawText(invoiceData.notes, { x: 30, y: noteY, size: 8, font: helvetica, color: gray, maxWidth: 300 });
  }

  // ── Footer ──
  page.drawRectangle({ x: 0, y: 0, width, height: 50, color: darkBlue });
  page.drawText('ขอบคุณที่ใช้บริการ / Thank you for your business', {
    x: width / 2 - 115, y: 30, size: 9, font: helveticaBold, color: white,
  });
  page.drawText(`${CONFIG.COMPANY.tel} | ${CONFIG.COMPANY.email}`, {
    x: width / 2 - 95, y: 15, size: 7.5, font: helvetica, color: rgb(0.7, 0.85, 1),
  });

  // ── Signature area ──
  const sigY = 70;
  page.drawText('ผู้รับของ/Received by ____________________', { x: 30, y: sigY + 20, size: 8, font: helvetica, color: gray });
  page.drawText('วันที่: ________________', { x: 30, y: sigY + 5, size: 8, font: helvetica, color: gray });
  page.drawText('ผู้มีอำนาจลงนาม/Authorized Signature ____________________', { x: width - 280, y: sigY + 20, size: 8, font: helvetica, color: gray });
  page.drawText('ตราบริษัท/Company Stamp', { x: width - 200, y: sigY + 5, size: 8, font: helvetica, color: gray });

  return await pdfDoc.save();
}

function formatNumber(n) {
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ==================== GOOGLE SHEETS ====================
async function appendToGoogleSheet(invoiceData) {
  try {
    const auth = new google.auth.JWT({
      email: CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const values = [[
      invoiceData.invoiceNumber,
      invoiceData.date,
      invoiceData.customerName,
      invoiceData.customerTaxId,
      invoiceData.customerAddress,
      invoiceData.customerBranch || 'สำนักงานใหญ่',
      invoiceData.subtotal,
      invoiceData.totalDiscount || 0,
      invoiceData.vat,
      invoiceData.total,
      invoiceData.notes || '',
      new Date().toLocaleString('th-TH'),
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'RAW',
      resource: { values },
    });

    console.log('✅ Saved to Google Sheets:', invoiceData.invoiceNumber);
  } catch (err) {
    console.error('❌ Google Sheets error:', err.message);
  }
}

// ==================== API ROUTES ====================

// Serve form page
app.get('/form', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'form.html'));
});

// Serve download page
app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// Submit invoice form
app.post('/api/submit-invoice', async (req, res) => {
  try {
    const { sessionId, userId, formData } = req.body;

    // Validate session
    if (!sessions[userId] || sessions[userId].sessionId !== sessionId) {
      return res.status(400).json({ error: 'Session ไม่ถูกต้องหรือหมดอายุ' });
    }

    // Calculate totals
    const items = formData.items || [];
    const subtotal = items.reduce((sum, item) => {
      const amt = (item.qty * item.unitPrice) - (item.discount || 0);
      item.amount = amt;
      return sum + amt;
    }, 0);
    const totalDiscount = formData.totalDiscount || 0;
    const vatBase = subtotal - totalDiscount;
    const vat = Math.round(vatBase * 0.07 * 100) / 100;
    const total = vatBase + vat;

    const invoiceId = generateId();
    const invoiceNumber = getInvoiceNumber();
    const today = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });

    const invoiceData = {
      invoiceId,
      invoiceNumber,
      date: today,
      dueDate: formData.dueDate || today,
      ...formData,
      items,
      subtotal,
      totalDiscount,
      vat,
      total,
      userId,
      createdAt: new Date(),
    };

    // Generate PDF
    const pdfBytes = await generateInvoicePDF(invoiceData);

    // Save PDF
    if (!fs.existsSync('pdfs')) fs.mkdirSync('pdfs');
    const pdfPath = `pdfs/${invoiceId}.pdf`;
    fs.writeFileSync(pdfPath, pdfBytes);

    invoices[invoiceId] = invoiceData;

    const downloadUrl = `${CONFIG.BASE_URL}/download?id=${invoiceId}`;

    // Send Line message with download link
    await sendLineMessage(userId, [
      {
        type: 'flex',
        altText: 'ใบกำกับภาษีพร้อมดาวน์โหลด',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '✅ ใบกำกับภาษีพร้อมแล้ว!',
                weight: 'bold',
                size: 'lg',
                color: '#1a6b3a',
              },
              { type: 'separator', margin: 'md' },
              {
                type: 'box',
                layout: 'vertical',
                margin: 'md',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: `เลขที่: ${invoiceNumber}`, size: 'sm', color: '#333' },
                  { type: 'text', text: `ผู้ซื้อ: ${formData.customerName}`, size: 'sm', color: '#333' },
                  { type: 'text', text: `ยอดรวม: ${formatNumber(total)} บาท`, size: 'sm', color: '#1a3a5c', weight: 'bold' },
                ],
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#1a3a5c',
                action: {
                  type: 'uri',
                  label: '📥 ดาวน์โหลดใบกำกับภาษี',
                  uri: downloadUrl,
                },
              },
            ],
          },
        },
      },
    ]);

    res.json({ success: true, invoiceId, invoiceNumber, downloadUrl });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' });
  }
});

// Get invoice data for download page
app.get('/api/invoice/:id', (req, res) => {
  const invoice = invoices[req.params.id];
  if (!invoice) return res.status(404).json({ error: 'ไม่พบใบกำกับภาษี' });
  res.json(invoice);
});

// Download PDF & save to Google Sheets
app.post('/api/download/:id', async (req, res) => {
  const invoice = invoices[req.params.id];
  if (!invoice) return res.status(404).json({ error: 'ไม่พบใบกำกับภาษี' });

  // Save to Google Sheets when downloaded
  if (!invoice.downloadedAt) {
    invoice.downloadedAt = new Date();
    await appendToGoogleSheet(invoice);
  }

  res.json({ success: true, pdfUrl: `${CONFIG.BASE_URL}/pdfs/${invoice.invoiceId}.pdf` });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ==================== START SERVER ====================
if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('pdfs')) fs.mkdirSync('pdfs');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📌 Webhook URL: http://localhost:${PORT}/webhook`);
});
