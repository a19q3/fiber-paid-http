# Paid MCP Tool Example

Expose an HTTP endpoint for a tool call and wrap it with FiberMPP:

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
