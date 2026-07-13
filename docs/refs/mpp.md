# MPP Reference Notes

The current Payment HTTP Authentication Internet-Draft defines paid HTTP resources around `402 Payment Required`. It is a work in progress, not a final RFC.

Primary sources inspected:

- https://paymentauth.org/draft-httpauth-payment-00.txt
- https://paymentauth.org/draft-payment-intent-charge-00.txt
- https://paymentauth.org/draft-lightning-charge-00.txt
- https://mpp.dev/

Lifecycle implemented in Fiber Paid HTTP:

1. Client requests a protected resource.
2. Server returns `402` with `WWW-Authenticate: Payment` and a problem JSON body.
3. Client selects the Fiber payment method and pays through Fiber RPC.
4. Client retries with `Authorization: Payment <base64url credential>`.
5. Server verifies payment, serves the resource, and returns `Payment-Receipt`.

Fiber Paid HTTP implements this core contract and defines a proposed project-local `fiber` method profile. It does not claim that `fiber` is registered or standardized.

Important interface choices:

- The challenge `request` and optional `opaque` values are unpadded base64url of JCS JSON.
- The challenge ID uses the draft's fixed seven-slot HMAC-SHA256 recommendation.
- The credential exactly echoes the issued challenge; the gateway separately checks the stored resource descriptor against the current URL, method, and body digest.
- Receipts are unsigned method evidence and are emitted only for successful `2xx` delivery.
- 402 responses use `Cache-Control: no-store`.
- Receipt responses use `Cache-Control: private`.
