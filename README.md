# x402 Minimal Payment-Gated Server

A stripped-down x402 payment-gated API server for Aptos. No framework dependencies beyond Express. Uses a facilitator (hosted or local) to verify and settle payments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              x402 FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CLIENT                      SERVER                      FACILITATOR        │
│    │                           │                              │             │
│    │──── POST /fortune ───────>│                              │             │
│    │                           │                              │             │
│    │<─── 402 + requirements ───│                              │             │
│    │                           │                              │             │
│    │  [sign Aptos tx locally]  │                              │             │
│    │                           │                              │             │
│    │──── POST /fortune ───────>│                              │             │
│    │     + PAYMENT-SIGNATURE   │                              │             │
│    │                           │──── POST /verify ───────────>│             │
│    │                           │<─── { isValid: true } ───────│             │
│    │                           │                              │             │
│    │                           │──── POST /settle ───────────>│             │
│    │                           │<─── { tx: "0x..." } ─────────│             │
│    │                           │                              │             │
│    │<─── 200 + fortune ────────│                              │             │
│    │     + PAYMENT-RESPONSE    │                              │             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File Structure

```
x402-minimal-server/
├── server.js          # Express server - handles 402 flow, delegates to facilitator
├── client.js          # Test client - signs transactions and makes paid requests
├── package.json       # Dependencies (express, @aptos-labs/ts-sdk)
├── .env.local         # Environment variables (create from env.example)
└── env.example        # Example environment file
```

## How It Works

### Server (`server.js`)

The server implements the resource server role in x402:

1. **No Payment Header** → Returns 402 with `PAYMENT-REQUIRED` header containing:
   - Price (0.01 USDC)
   - Asset address (testnet USDC fungible asset)
   - Recipient address (your wallet)
   - Network (aptos:2 = testnet)
   - Sponsored flag (facilitator pays gas)

2. **With Payment Header** → Processes the payment:
   - Decodes the `PAYMENT-SIGNATURE` header
   - Calls facilitator `/verify` to validate the signed transaction
   - Calls facilitator `/settle` to submit on-chain
   - Returns the protected content with `PAYMENT-RESPONSE` header

### Client (`client.js`)

The client demonstrates a complete payment flow:

1. Makes initial request → receives 402
2. Parses payment requirements from response header
3. Builds an Aptos transaction calling `0x1::primary_fungible_store::transfer`
4. Signs with user's private key
5. Encodes to base64 and retries with `PAYMENT-SIGNATURE` header
6. Displays the fortune and transaction hash

## Setup

```bash
# Install dependencies
npm install

# Copy env file
cp env.example .env.local

# Edit .env.local:
# - PAYMENT_RECIPIENT_ADDRESS: your Aptos address to receive payments
# - NEXT_PUBLIC_APTOS_PRIVATE_KEY: private key for the test client
# - FACILITATOR_URL: (optional) defaults to hosted facilitator
```

## Running

### Start the Server

```bash
npm start
```

Server runs on port 3000 (or `PORT` env var).

### Test with Client

In a separate terminal:

```bash
npm run client
```

### Test with curl (402 only)

```bash
# Get 402 response
curl -X POST http://localhost:3000/fortune -v

# Decode the payment requirements
curl -s -X POST http://localhost:3000/fortune -D - | \
  grep -i payment-required | cut -d' ' -f2 | base64 -d | jq
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAYMENT_RECIPIENT_ADDRESS` | Yes | - | Aptos address to receive payments |
| `FACILITATOR_URL` | No | `https://x402-navy.vercel.app/facilitator` | Facilitator endpoint |
| `PORT` | No | `3000` | Server port |
| `NEXT_PUBLIC_APTOS_PRIVATE_KEY` | Client | - | Private key for test client |
| `APTOS_PRIVATE_KEY` | Client | - | Alternative env var for client |

## Protocol Details

| Parameter | Value |
|-----------|-------|
| Network | `aptos:2` (Aptos Testnet) |
| Price | 0.01 USDC (10000 atomic units) |
| Asset | `0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832` |
| Sponsored | Yes (facilitator pays gas) |

## HTTP Headers

| Header | Direction | Description |
|--------|-----------|-------------|
| `PAYMENT-REQUIRED` | Server → Client | Base64-encoded payment requirements (on 402) |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded signed payment payload |
| `PAYMENT-RESPONSE` | Server → Client | Base64-encoded settlement result (on 200) |

## Notable Implementation Details

### Server Calls Both Verify and Settle

The server explicitly calls both endpoints:
```javascript
const verifyResult = await verifyPayment(paymentPayload, paymentRequirements);
// ... check isValid ...
const settleResult = await settlePayment(paymentPayload, paymentRequirements);
```

**Note:** The facilitator's `/settle` endpoint internally verifies before settling, so the explicit `/verify` call is technically redundant. However, it provides:
- Explicit verification feedback before settlement
- Opportunity to reject early without attempting settlement
- Clearer logging/debugging

In a minimal implementation, you could skip `/verify` and just call `/settle`.

### Transaction Construction (Client)

The client builds a fee payer transaction:
```javascript
const transaction = await aptos.transaction.build.simple({
  sender: account.accountAddress,
  withFeePayer: true,  // Sponsored - facilitator fills in fee payer
  data: {
    function: "0x1::primary_fungible_store::transfer",
    typeArguments: ["0x1::fungible_asset::Metadata"],
    functionArguments: [asset, payTo, amount]
  }
});
```

The `withFeePayer: true` flag creates a transaction where:
- The sender signs the transfer
- The fee payer (facilitator) signs separately and pays gas
- Client pays 0 APT for gas

### Payload Encoding

The signed transaction is encoded as:
```javascript
{
  transaction: Array.from(transactionBytes),      // BCS-serialized SimpleTransaction
  senderAuthenticator: Array.from(authenticatorBytes)  // BCS-serialized signature
}
// Then base64 encoded
```

This format matches `@rvk_rishikesh/aptos` used in the workshop.

### No On-Chain Interaction on Server

The server never touches the blockchain directly:
- All on-chain operations delegated to facilitator
- Only needs `PAYMENT_RECIPIENT_ADDRESS` for requirements

### USDC on Testnet

The hardcoded USDC address is a pre-deployed fungible asset on Aptos testnet:
```
0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832
```

To test, you need testnet USDC in your payer wallet (not just APT).

## Using a Local Facilitator

Instead of the hosted facilitator, you can run your own:

```bash
# Terminal 1: Start local facilitator
git clone https://github.com/aashidham/x402-minimal-facilitator-aptos
cd x402-minimal-facilitator
npm start  # Runs on port 4022

# Terminal 2: Start server pointing to local facilitator
export FACILITATOR_URL=http://localhost:4022
npm start
```

## Debugging

Both server and client use verbose logging. Look for:
- `📋 VERIFY REQUEST` / `VERIFY RESPONSE`
- `📋 SETTLE REQUEST` / `SETTLE RESPONSE`
- `402 Payment Required`
- `200 OK - Fortune Delivered`

## Security Considerations

- Never expose your private key in client-side code in production
- The server doesn't validate payment amounts match config (relies on facilitator)
- In production, add authentication and rate limiting
- Consider using environment-specific USDC addresses
