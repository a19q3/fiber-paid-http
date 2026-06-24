# Paid API Example

```ts
import { createFiberMppMiddleware } from "@fiber-mpp/server-middleware";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { InMemoryStore } from "@fiber-mpp/storage";

const fiberMpp = createFiberMppMiddleware({
  secret: process.env.FIBER_MPP_SECRET!,
  serverId: "example-api",
  store: new InMemoryStore(),
  fiber: new FiberMethodAdapter({ mode: "mock" }),
  allowInMemoryStore: true
});

export const paidHandler = fiberMpp.protect({
  price: { value: "0.01", currency: "USD" },
  methods: ["fiber"],
  handler: async () => Response.json({ data: "paid resource" })
});
```
