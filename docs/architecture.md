# Architecture

FiberMPP is a TypeScript monorepo with these layers:

- `packages/core`: typed protocol model, canonical JSON, HMAC signatures, base64url encoding, resource hashes, HTTP header helpers.
- `packages/storage`: replay/session/receipt storage interface plus durable SQLite implementation.
- `packages/fiber-method`: Fiber JSON-RPC adapter for local/testnet Fiber nodes.
- `packages/f402-compat`: F402 challenge/proof conversion.
- `packages/server-middleware`: route protection and reverse proxy mode.
- `packages/client`: paid fetch helper.
- `packages/cli`: gateway, bootstrap, payment, vector, and local evidence tooling.
- `apps/evidence-api`: local evidence API for the 402 -> Fiber payment -> receipt -> replay rejection flow.
- `apps/evidence-web`: browser evidence console.

## Request flow

```mermaid
sequenceDiagram
  participant C as Client
  participant S as FiberMPP Middleware
  participant F as Fiber Adapter
  participant A as App Handler

  C->>S: GET /paid/weather
  S->>F: create Fiber challenge
  S-->>C: 402 + WWW-Authenticate: Payment
  C->>F: pay invoice through Fiber RPC
  C->>S: GET /paid/weather + Authorization: Payment
  S->>S: verify signature, expiry, binding, replay
  S->>F: verify payment status
  S->>A: serve protected resource
  A-->>S: response body
  S-->>C: 200 + Payment-Receipt
```

## Storage

The middleware stores issued challenges, used credentials, receipts, payment observations, resource hashes, and idempotency state. Durable SQLite or Redis-compatible storage is required.
