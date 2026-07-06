# Paid MCP Tool Example

> **README-only skeleton.** Source under `examples/paid-mcp-tool/src` is not yet shipped. The snippet below shows the intended wiring; copy and adapt it to your own host project.

Expose an HTTP endpoint for a tool call and wrap it with Fiber Paid HTTP:

```ts
const paidTool = fiberMpp.protect({
  price: { value: "1", currency: "CKB", display: "1 CKB" },
  methods: ["fiber"],
  fiberAmountShannons: "100000000",
  handler: async (request) => {
    const args = await request.json();
    return Response.json({
      tool: "example.lookup",
      result: args
    });
  }
});
```

The caller performs the normal MPP flow and receives `Payment-Receipt` with the tool response.
