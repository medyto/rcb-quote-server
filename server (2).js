const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json({ limit: '25mb' })); // Allow large payloads for images
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// Rate limiter: max 10 requests per IP per hour
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
app.use('/api/quote', limiter);

// Usage tracking: key = "email:YYYY-MM" → count (resets each month automatically)
const usageMap = {};

function getUsageKey(email) {
  const now = new Date();
  const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return email.toLowerCase().trim() + ':' + month;
}

function getUsage(email) { return usageMap[getUsageKey(email)] || 0; }
function incrementUsage(email) {
  const key = getUsageKey(email);
  usageMap[key] = (usageMap[key] || 0) + 1;
}

// Pricing (mirrors your Excel formulas)
const FOAM_PRICES = { '0':0, '1':3.35, '2':4.44, '2.5':6.15, '3':7.80, 'MEM':12, 'LTX':15, 'DFT':14.73 };
const LABOUR_RATE = 110;
const MONTHLY_LIMIT = 2;
const COMPANY_EMAIL = 'info@rcb.ca';

function calcLine(qty, W, L, T, density, fabricPrice, hasBack, extras) {
  const AC = hasBack === 'y' ? 2.0 : 1.5;
  const foamPrice = FOAM_PRICES[String(density)] || 0;
  const yards = (W + T) * (L * AC) / 1296;
  const fabricCost = yards * fabricPrice;
  const foamBF = (W * L) / 144 * T;
  const foamCost = foamBF * foamPrice;
  const stripHrs = T <= 4 ? 0.3 : 0.25;
  const sewHrs = (W + L) * 3 / 200;
  const foamHrs = (W + L) * 3 / 300;
  const upholHrs = extras.uphol ? (L + T) * 3 / 100 : 0;
  const totalHrs = stripHrs + sewHrs + foamHrs + upholHrs;
  const labour = totalHrs * LABOUR_RATE;
  const zipCost = extras.zip ? 1.2 * L / 2 : 0;
  const wrapCost = extras.wrap ? foamBF / 2 : 0;
  return {
    label: qty + ' x ' + W + '"x' + L + '"x' + T + '" (' + density + 'lb foam)',
    yards: yards * qty,
    fabricCost: fabricCost * qty,
    foamCost: foamCost * qty,
    labour: labour * qty,
    extras: (zipCost + wrapCost) * qty,
    hrs: totalHrs * qty,
    lineTotal: (fabricCost + foamCost + labour + zipCost + wrapCost) * qty,
  };
}

function fmt(n) { return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function buildEmailBody(customerName, customerEmail, lines, totals, extrasLabel) {
  const today = new Date().toLocaleDateString('en-CA', { year:'numeric', month:'long', day:'numeric' });
  const itemLines = lines.map(function(l) { return '  - ' + l.label; }).join('\n');
  return (
    'NEW QUOTE REQUEST\n' +
    '================================\n' +
    'Customer Name:  ' + customerName + '\n' +
    'Customer Email: ' + customerEmail + '\n' +
    'Date:           ' + today + '\n' +
    '================================\n\n' +
    'ITEMS:\n' + itemLines + '\n\n' +
    'PRICING BREAKDOWN:\n' +
    '  Fabric (' + totals.yards.toFixed(2) + ' yds)        ' + fmt(totals.fabric) + '\n' +
    '  Foam                         ' + fmt(totals.foam) + '\n' +
    '  Labour (' + totals.hrs.toFixed(1) + ' hrs @ $' + LABOUR_RATE + '/hr)  ' + fmt(totals.labour) + '\n' +
    '  Extras (' + extrasLabel + ')  ' + fmt(totals.extras) + '\n' +
    '  ------------------------------\n' +
    '  TOTAL                        ' + fmt(totals.grand) + '\n\n' +
    '================================\n' +
    (totals.imageCount > 0 ? totals.imageCount + ' image(s) attached.\n' : 'No images attached.\n') +
    '================================\n'
  );
}

// Main quote endpoint
app.post('/api/quote', async function(req, res) {
  const { customerName, customerEmail, cushions, extras } = req.body;

  if (!customerName || !customerEmail || !cushions || !cushions.length) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const email = customerEmail.toLowerCase().trim();

  // Check monthly limit
  const usage = getUsage(email);
  if (usage >= MONTHLY_LIMIT) {
    return res.status(429).json({
      error: 'limit_reached',
      message: 'You have used your ' + MONTHLY_LIMIT + ' free quotes this month. Please contact us at ' + COMPANY_EMAIL + ' for additional quotes.'
    });
  }

  // Calculate
  const lines = [];
  let totFabric = 0, totFoam = 0, totLabour = 0, totExtras = 0, totHrs = 0, totYards = 0;

  cushions.forEach(function(c) {
    if (!c.width || !c.length || !c.thickness) return;
    const r = calcLine(c.qty, c.width, c.length, c.thickness, c.density, c.fabricPrice, c.hasBack, extras || {});
    lines.push(r);
    totFabric += r.fabricCost; totFoam += r.foamCost; totLabour += r.labour;
    totExtras += r.extras; totHrs += r.hrs; totYards += r.yards;
  });

  const grandTotal = totFabric + totFoam + totLabour + totExtras;
  const extrasLabel = [extras.zip && 'Zipper/Velcro', extras.wrap && 'Wrap', extras.uphol && 'Upholstery'].filter(Boolean).join(', ') || 'None';
  // Collect images from all cushions as attachments
  const attachments = [];
  let imageCount = 0;
  cushions.forEach(function(c, ci) {
    if (c.images && c.images.length) {
      c.images.forEach(function(img, ii) {
        const match = img.data && img.data.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          imageCount++;
          attachments.push({
            filename: 'Cushion_' + (ci + 1) + '_Image_' + (ii + 1) + '_' + (img.name || 'photo.jpg'),
            content: match[2],
            encoding: 'base64',
            contentType: match[1],
          });
        }
      });
    }
  });

  const totals = { fabric: totFabric, foam: totFoam, labour: totLabour, extras: totExtras, hrs: totHrs, yards: totYards, grand: grandTotal, imageCount };
  const emailBody = buildEmailBody(customerName, email, lines, totals, extrasLabel);

  // Send via Gmail SMTP
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  try {
    await transporter.sendMail({
      from: '"RCB Quote Form" <' + process.env.GMAIL_USER + '>',
      to: COMPANY_EMAIL,
      subject: 'New Quote Request from ' + customerName + ' — ' + fmt(grandTotal),
      text: emailBody,
      attachments: attachments,
    });

    incrementUsage(email);
    const remaining = MONTHLY_LIMIT - (usage + 1);

    res.json({
      success: true,
      total: fmt(grandTotal),
      remaining: remaining,
      message: 'Quote sent to ' + email + '!'
    });

  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email. Please try again.' });
  }
});

app.use(express.static(__dirname)); // serve quote-form.html
app.get('/', function(req, res) { res.json({ status: 'RCB Quote Server running' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('RCB Quote Server running on port ' + PORT); });
