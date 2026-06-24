# MPP Reference Notes

Machine Payments Protocol standardizes paid HTTP resources around the dormant `402 Payment Required` status code.

Lifecycle implemented in FiberMPP:

1. Client requests a protected resource.
2. Server returns `402` with `WWW-Authenticate: Payment` and a problem JSON body.
3. Client selects the Fiber payment method and pays through Fiber RPC.
4. Client retries with `Authorization: Payment <base64url credential>`.
5. Server verifies payment, serves the resource, and returns `Payment-Receipt`.

FiberMPP keeps the core MPP model focused on Fiber as the production payment method.

Important interface choices:

- Challenge and receipt payloads are canonical JSON before HMAC signing.
- The credential carries a resource hash so it cannot be replayed against a different URL/method/body.
- 402 responses use `Cache-Control: no-store`.
