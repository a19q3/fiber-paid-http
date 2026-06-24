import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { FiberMethodAdapter } from "@fiber-mpp/fiber-method";
import { createFiberMppMiddleware, type FiberMppMiddlewareConfig } from "@fiber-mpp/server-middleware";
import { InMemoryStore } from "@fiber-mpp/storage";

export type DemoApiOptions = Partial<FiberMppMiddlewareConfig> & {
  price?: { value: string; currency: string; display?: string };
  fiberAmountShannons?: string;
};

export function createDemoApi(options: DemoApiOptions = {}): Hono {
  const app = new Hono();
  const fiber =
    options.fiber ??
    new FiberMethodAdapter({
      mode: "mock",
      asset: "CKB",
      currency: "Fibd",
      rpcLabel: "demo-mock"
    });
  const middleware = createFiberMppMiddleware({
    secret: options.secret ?? "fiber-mpp-demo-secret-at-least-16",
    serverId: options.serverId ?? "fiber-mpp-demo-api",
    store: options.store ?? new InMemoryStore(),
    fiber,
    defaultFiberAmountShannons: options.fiberAmountShannons ?? "1000",
    challengeTtlSeconds: options.challengeTtlSeconds ?? 120,
    clockSkewSeconds: options.clockSkewSeconds ?? 2,
    production: options.production,
    allowInMemoryStore: options.allowInMemoryStore
  });

  const price = options.price ?? { value: "0.01", currency: "USD", display: "$0.01" };

  app.use("*", async (c, next) => {
    await next();
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "authorization, content-type");
    c.header("access-control-expose-headers", "payment-receipt, www-authenticate");
  });

  app.options("*", (c) =>
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS"
      }
    })
  );

  app.get("/free", (c) =>
    c.json({
      ok: true,
      message: "free FiberMPP demo route"
    })
  );

  app.get("/paid/weather", async (c) =>
    middleware.protect({
      price,
      methods: ["fiber"],
      fiberAmountShannons: options.fiberAmountShannons ?? "1000",
      handler: async () =>
        Response.json({
          city: "Shanghai",
          condition: "clear",
          paid: true
        })
    })(c.req.raw)
  );

  app.get("/paid/mcp-tool", async (c) =>
    middleware.protect({
      price,
      methods: ["fiber"],
      handler: async () =>
        Response.json({
          tool: "fiber_mpp.echo",
          result: { text: "paid MCP tool result" }
        })
    })(c.req.raw)
  );

  app.get("/paid/file", async (c) =>
    middleware.protect({
      price,
      methods: ["fiber"],
      handler: async () =>
        new Response("paid file contents\n", {
          headers: { "content-type": "text/plain" }
        })
    })(c.req.raw)
  );

  app.post("/paid/echo", async (c) =>
    middleware.protect({
      price,
      methods: ["fiber"],
      handler: async (request) =>
        Response.json({
          paid: true,
          echo: await request.json().catch(() => null)
        })
    })(c.req.raw)
  );

  return app;
}

export function startDemoApi(port = Number(process.env.PORT ?? "8787")): void {
  const app = createDemoApi();
  serve({ fetch: app.fetch, port });
  console.log(`FiberMPP demo API listening on http://localhost:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDemoApi();
}
