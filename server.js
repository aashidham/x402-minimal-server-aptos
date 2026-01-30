import express from 'express';
import morgan from 'morgan';

const app = express();
app.use(express.json());
app.use(morgan('dev'));

// Configuration from environment
const PORT = process.env.PORT || 3000;
const PAY_TO_ADDRESS = process.env.PAYMENT_RECIPIENT_ADDRESS;
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402-navy.vercel.app/facilitator';

// USDC on Aptos testnet
const USDC_ASSET = '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832';
const NETWORK = 'aptos:2'; // testnet
const PRICE_ATOMIC = '10000'; // 0.01 USDC (6 decimals)

const fortunes = [
  "The blockchain never lies.",
  "Your resources are safe in the Move VM.",
  "Move fast and break things (safely).",
  "A transaction awaits, seize the block.",
  "Your next upgrade will compile on first try.",
  "The oracle speaks: HODL wisdom, not just coins.",
  "Smart contracts make smarter decisions.",
  "Your keys, your fortune.",
];

// Pretty print helper
function logJson(label, obj) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📋 ${label}`);
  console.log('─'.repeat(60));
  console.log(JSON.stringify(obj, null, 2));
  console.log('─'.repeat(60) + '\n');
}

// Build the PaymentRequired response
function buildPaymentRequired(requestUrl) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: requestUrl,
      description: "Fortune Cookie API - Pay 0.01 USDC for wisdom",
      mimeType: "application/json"
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: PRICE_ATOMIC,
        asset: USDC_ASSET,
        payTo: PAY_TO_ADDRESS,
        maxTimeoutSeconds: 60,
        extra: {
          sponsored: true
        }
      }
    ]
  };
}

// Call facilitator to verify payment
async function verifyPayment(paymentPayload, paymentRequirements) {
  const requestBody = { paymentPayload, paymentRequirements };

  logJson('VERIFY REQUEST → Facilitator', {
    url: `${FACILITATOR_URL}/verify`,
    body: requestBody
  });

  const response = await fetch(`${FACILITATOR_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  const result = await response.json();
  logJson('VERIFY RESPONSE ← Facilitator', result);

  return result;
}

// Call facilitator to settle payment
async function settlePayment(paymentPayload, paymentRequirements) {
  const requestBody = { paymentPayload, paymentRequirements };

  logJson('SETTLE REQUEST → Facilitator', {
    url: `${FACILITATOR_URL}/settle`,
    body: requestBody
  });

  const response = await fetch(`${FACILITATOR_URL}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  const result = await response.json();
  logJson('SETTLE RESPONSE ← Facilitator', result);

  return result;
}

// Main fortune endpoint
app.post('/fortune', async (req, res) => {
  const requestUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  // Check for payment signature header
  const paymentSignature = req.headers['payment-signature'];

  if (!paymentSignature) {
    // No payment - return 402 with payment requirements
    const paymentRequired = buildPaymentRequired(requestUrl);
    const paymentRequiredB64 = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

    logJson('402 Payment Required', paymentRequired);

    res.status(402)
      .set('PAYMENT-REQUIRED', paymentRequiredB64)
      .json({ error: "Payment required", x402Version: 2 });
    return;
  }

  try {
    // Decode the payment payload
    const paymentPayload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString('utf-8'));

    logJson('RECEIVED PaymentPayload', paymentPayload);

    // Build payment requirements for verification
    const paymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      amount: PRICE_ATOMIC,
      asset: USDC_ASSET,
      payTo: PAY_TO_ADDRESS,
      maxTimeoutSeconds: 60,
      extra: { sponsored: true }
    };

    // Step 1: Verify the payment with facilitator
    console.log('\n🔍 Verifying payment with facilitator...');
    const verifyResult = await verifyPayment(paymentPayload, paymentRequirements);

    if (!verifyResult.isValid) {
      console.log('❌ Payment verification failed');
      res.status(402).json({
        error: "Payment verification failed",
        reason: verifyResult.invalidReason || verifyResult.error
      });
      return;
    }

    console.log('✅ Payment verified!');

    // Step 2: Settle the payment
    console.log('\n💰 Settling payment...');
    const settleResult = await settlePayment(paymentPayload, paymentRequirements);

    if (!settleResult.success) {
      console.log('❌ Settlement failed');
      res.status(402).json({
        error: "Payment settlement failed",
        reason: settleResult.errorReason || settleResult.error
      });
      return;
    }

    console.log('✅ Payment settled! Transaction:', settleResult.transaction);

    // Step 3: Return the fortune with payment response header
    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)];

    const settlementResponse = {
      success: true,
      transaction: settleResult.transaction,
      network: NETWORK,
      payer: verifyResult.payer || settleResult.payer
    };
    const paymentResponseB64 = Buffer.from(JSON.stringify(settlementResponse)).toString('base64');

    logJson('200 OK - Fortune Delivered', { fortune, settlement: settlementResponse });

    res.status(200)
      .set('PAYMENT-RESPONSE', paymentResponseB64)
      .json({ fortune, transaction: settleResult.transaction });

  } catch (error) {
    console.error('❌ Error processing payment:', error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', facilitator: FACILITATOR_URL });
});

// Startup validation
if (!PAY_TO_ADDRESS) {
  console.error('ERROR: PAYMENT_RECIPIENT_ADDRESS environment variable is required');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           x402 Minimal Payment-Gated Server                ║
╠════════════════════════════════════════════════════════════╣
║  Endpoint:    POST /fortune                                ║
║  Price:       0.01 USDC                                    ║
║  Network:     ${NETWORK.padEnd(43)}║
║  Pay To:      ${PAY_TO_ADDRESS.slice(0, 10)}...${PAY_TO_ADDRESS.slice(-8).padEnd(28)}║
║  Facilitator: ${FACILITATOR_URL.slice(0, 43).padEnd(43)}║
║  Port:        ${String(PORT).padEnd(43)}║
╚════════════════════════════════════════════════════════════╝
`);
});
