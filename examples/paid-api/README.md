# Paid API Example

```ts
import { createFiberMppMiddleware } from "@fiber-mpp/server-middleware";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { SqliteStore } from "@fiber-mpp/storage";

const fiberMpp = createFiberMppMiddleware({
  secret: process.env.FIBER_MPP_SECRET!,
  serverId: "example-api",
  store: new SqliteStore("./fiber-mpp.example.sqlite"),
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
export FIBER_MPP_SECRET="$(openssl rand -hex 32)"
```
