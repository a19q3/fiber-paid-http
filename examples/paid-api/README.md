# Paid API Example

```ts
import { createFiberPaidHttpMiddleware } from "@fiber-paid-http/server-middleware";
import { FiberMethodAdapter } from "@fiber-paid-http/fiber-method";
import { SqliteStore } from "@fiber-paid-http/storage";

const fiberMpp = createFiberPaidHttpMiddleware({
  secret: process.env.FIBER_PAID_HTTP_SECRET!,
  serverId: "example-api",
  store: new SqliteStore("./fiber-paid-http.example.sqlite"),
  fiber: FiberMethodAdapter.fromEnv(process.env, "payee")
});

export const paidHandler = fiberMpp.protect({
  price: { value: "1", currency: "CKB", display: "1 CKB" },
  methods: ["fiber"],
  fiberAmountShannons: "100000000",
  handler: async () => Response.json({ data: "paid resource" })
});
```

Required runtime configuration:

```bash
export FIBER_MODE=local              # or testnet
export FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716
export FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)"
```
