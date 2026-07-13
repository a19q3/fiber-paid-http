# Gateway bootstrap

Generate a configuration:

```bash
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
pnpm exec fiber-paid-http init --role gateway --out fiber-paid-http.gateway.json
```

The generated production shape is:

```json
{
  "role": "gateway",
  "listen": "127.0.0.1:8790",
  "server_id": "fiber-paid-http-gateway",
  "realm": "paid.example.com",
  "public_base_url": "https://paid.example.com",
  "upstream": "http://127.0.0.1:8080",
  "storage": "sqlite://./fiber-paid-http.sqlite",
  "charge": {
    "amount": "100000000",
    "currency": "CKB",
    "description": "Paid HTTP request"
  },
  "secret_env": "FIBER_PAID_HTTP_SECRET",
  "previous_secret_envs": [],
  "operations": {
    "health_path": "/healthz",
    "readiness_path": "/readyz",
    "metrics_path": "/metrics",
    "request_body_limit_bytes": 1048576,
    "upstream_response_limit_bytes": 8388608,
    "upstream_timeout_ms": 30000,
    "shutdown_grace_ms": 10000,
    "rate_limit": {
      "window_ms": 60000,
      "max_requests": 300
    }
  },
  "fiber": {
    "mode": "local",
    "payee_rpc_url": "http://127.0.0.1:21716",
    "payer_rpc_url": "http://127.0.0.1:21714",
    "currency": "Fibd"
  }
}
```

`charge.amount` is a positive decimal string in the asset's smallest unit. `charge.currency` is the MPP-facing asset name; `fiber.currency` is the invoice currency code expected by the connected Fiber node.

## Required checks

```bash
pnpm exec fiber-paid-http doctor --role gateway --config fiber-paid-http.gateway.json
```

The gateway is blocked unless:

- `realm` is non-empty;
- `public_base_url` is absolute HTTPS, except when local HTTP is explicitly enabled;
- `storage` is SQLite;
- the active secret, all rotation secrets, and any F-L402 root key contain at least 32 characters;
- `charge.amount` and `charge.currency` are valid;
- `FIBER_MODE` is local or testnet;
- the payee Fiber RPC is reachable and reports a connected peer and ready channel for a live deployment;
- literal RPC credentials are absent from config and supplied through environment variables;
- log redaction, request limits, and rate limiting remain enabled.

The Rust gateway implements the three operation paths directly. `/readyz` checks both SQLite integrity/configuration and the payee Fiber node's peer plus `ChannelReady` state. Upstream credentials and hop-by-hop headers are stripped; upstream calls have a timeout and a bounded response body.

Start the TypeScript reference gateway:

```bash
pnpm exec fiber-paid-http serve --config fiber-paid-http.gateway.json
```

Start the Rust production gateway:

```bash
cargo run -p fiber-paid-http-cli -- server --config fiber-paid-http.gateway.json
```

The Rust listener is intentionally plain HTTP on loopback/private infrastructure. Terminate public TLS in front of it and keep `public_base_url` set to the external HTTPS origin.

## Secret rotation

Set a new `secret_env` value and list the previous environment variable in `previous_secret_envs`. New challenges use only the active key; verification temporarily accepts both. Remove the previous key after the longest challenge TTL has expired.

Receipts do not use a gateway signature, so rotation affects only challenge ID validation.

## Storage audit

```bash
pnpm exec fiber-paid-http storage health --storage sqlite://./fiber-paid-http.sqlite
pnpm exec fiber-paid-http receipts export --storage sqlite://./fiber-paid-http.sqlite --out receipts.ndjson
pnpm exec fiber-paid-http receipts audit --storage sqlite://./fiber-paid-http.sqlite
```

The audit validates the MPP-draft receipt schema and reports SQLite schema version, WAL mode, foreign keys, integrity, receipt counts, and failed deliveries. TypeScript and Rust share one exact schema v1; an unsupported version or noncanonical table layout fails at startup, so start this new project with a clean database.

## TLS and proxying

Terminate TLS in front of the gateway and configure the externally visible origin in `public_base_url`. Payment resource binding is constructed from that value plus the request path and query. Do not rely on `Host`, `Forwarded`, or `X-Forwarded-*` for authorization binding.
