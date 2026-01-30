/**
 * x402 Test Client for Aptos
 *
 * This script demonstrates the full x402 payment flow:
 * 1. Request resource -> get 402 with payment requirements
 * 2. Construct and sign Aptos transaction
 * 3. Retry request with signed payment
 * 4. Receive paid content
 */

import {
  Account,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network
} from '@aptos-labs/ts-sdk';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const PRIVATE_KEY = process.env.APTOS_PRIVATE_KEY || process.env.NEXT_PUBLIC_APTOS_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('ERROR: APTOS_PRIVATE_KEY or NEXT_PUBLIC_APTOS_PRIVATE_KEY required');
  console.error('Usage: APTOS_PRIVATE_KEY=0x... node client.js');
  process.exit(1);
}

// Encode transaction + authenticator to base64 (matches @rvk_rishikesh/aptos format)
function encodeAptosPayload(transactionBytes, authenticatorBytes) {
  const payload = {
    transaction: Array.from(transactionBytes),
    senderAuthenticator: Array.from(authenticatorBytes)
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

async function main() {
  // Initialize Aptos client and account
  const privateKeyHex = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const account = Account.fromPrivateKey({ privateKey });

  const config = new AptosConfig({ network: Network.TESTNET });
  const aptos = new Aptos(config);

  console.log(`\nWallet: ${account.accountAddress.toString()}`);
  console.log(`Server: ${SERVER_URL}/fortune\n`);

  // Step 1: Make initial request (expect 402)
  console.log('Step 1: Requesting fortune (expecting 402)...');
  const initialResponse = await fetch(`${SERVER_URL}/fortune`, { method: 'POST' });

  if (initialResponse.status !== 402) {
    console.log('Unexpected response:', initialResponse.status);
    console.log(await initialResponse.text());
    return;
  }

  // Step 2: Parse payment requirements from header
  const paymentRequiredB64 = initialResponse.headers.get('payment-required');
  if (!paymentRequiredB64) {
    console.error('No PAYMENT-REQUIRED header in 402 response');
    return;
  }

  const paymentRequired = JSON.parse(Buffer.from(paymentRequiredB64, 'base64').toString('utf-8'));
  console.log('Payment required:', JSON.stringify(paymentRequired, null, 2));

  const requirements = paymentRequired.accepts[0];
  console.log(`\nPrice: ${Number(requirements.amount) / 1e6} USDC`);
  console.log(`Pay to: ${requirements.payTo}`);
  console.log(`Sponsored: ${requirements.extra?.sponsored}`);

  // Step 3: Build and sign the payment transaction
  console.log('\nStep 2: Building payment transaction...');

  const sponsored = requirements.extra?.sponsored === true;

  // Build a fee payer transaction (facilitator sponsors gas)
  const transaction = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    withFeePayer: sponsored, // Sponsored transaction - fee payer will be filled by facilitator
    data: {
      function: "0x1::primary_fungible_store::transfer",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [
        requirements.asset,        // USDC metadata address
        requirements.payTo,        // recipient
        requirements.amount        // amount in atomic units
      ]
    }
  });

  // Sign the transaction with authenticator (this is what the facilitator expects)
  const senderAuthenticator = account.signTransactionWithAuthenticator(transaction);

  // Serialize using bcsToBytes (matches the SDK's expected format)
  const transactionBytes = transaction.bcsToBytes();
  const authenticatorBytes = senderAuthenticator.bcsToBytes();

  // Encode to base64 in the format the facilitator expects
  const transactionB64 = encodeAptosPayload(transactionBytes, authenticatorBytes);

  // Step 4: Build the full PaymentPayload
  const paymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: requirements,
    payload: {
      transaction: transactionB64
    }
  };

  const paymentSignatureB64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  // Step 5: Retry with payment
  console.log('Step 3: Sending payment...');
  const paidResponse = await fetch(`${SERVER_URL}/fortune`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentSignatureB64
    }
  });

  console.log(`Response status: ${paidResponse.status}`);

  // Check for payment response header
  const paymentResponseB64 = paidResponse.headers.get('payment-response');
  if (paymentResponseB64) {
    const paymentResponse = JSON.parse(Buffer.from(paymentResponseB64, 'base64').toString('utf-8'));
    console.log('\nPayment response:', JSON.stringify(paymentResponse, null, 2));
    if (paymentResponse.transaction) {
      console.log(`\nView on explorer: https://explorer.aptoslabs.com/txn/${paymentResponse.transaction}?network=testnet`);
    }
  }

  const body = await paidResponse.json();
  console.log('\nResponse body:', JSON.stringify(body, null, 2));

  if (body.fortune) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  YOUR FORTUNE: "${body.fortune}"`);
    console.log(`${'='.repeat(50)}\n`);
  }
}

main().catch(console.error);
