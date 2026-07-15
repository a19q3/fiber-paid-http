# Isolated public demo deployment

This profile runs `fiber-demo.avato.online` beside another Fiber Paid HTTP
deployment without sharing writable state. It is intended for a resettable,
public hackathon demo, not for production settlement.

## Isolation boundary

The demo has its own:

- Linux network namespace and loopback network;
- CKB dev chain, Fiber node stores, RPC and P2P listeners;
- Fiber Paid HTTP checkout, `.tmp` directory and SQLite databases;
- challenge secret and Battlecode ledger;
- Battlecode checkout and generated match files;
- systemd units and Nginx virtual host.

The host may share read-only system toolchains, including CKB, JDK and the pnpm
content-addressed store. Application binaries used by the sandbox are copied
into its own `runtime/artifacts` directory. The production checkout,
environment file, database, systemd units and Nginx virtual host are not
modified or restarted.

The default award mode is `local-ledger`, so the sandbox intentionally opens
only the payer-to-payee xUDT route. Enable `FIBER_LOCAL_PRIZE_ROUTE=1` only
together with an explicitly tested live `fiber-xudt` reverse payout mode.

```text
Internet
   |
   v
Nginx on host
   |
   +-- fiber.avato.online ------> existing deployment
   |
   `-- fiber-demo.avato.online -> 10.203.0.2:8878 / :8877
                                  |
                                  `-- network namespace
                                      CKB  :8114
                                      FNN  :21714..21716
```

## Server layout

The checked-in unit files assume:

```text
/srv/fiber-public-demo/fiber-paid-http
/srv/fiber-public-demo/fiber
/srv/fiber-public-demo/battlecode25-scaffold
/srv/fiber-public-demo/runtime
/etc/fiber-demo-sandbox.env
```

Copy the pinned Battlecode engine jar into the sandbox `runtime/artifacts`
directory. Do not point the runner at a mutable Gradle cache used by another
deployment.

Generate a unique secret while creating the environment file:

```bash
umask 077
secret="$(openssl rand -hex 32)"
sudo install -o root -g root -m 0600 \
  deploy/fiber-demo/fiber-demo.env.example \
  /etc/fiber-demo-sandbox.env
sudo sed -i "s|__GENERATE_AT_INSTALL__|${secret}|" \
  /etc/fiber-demo-sandbox.env
```

Adjust the JDK and binary paths in the installed environment file. Never copy
the secret or database from an existing deployment.

The optional `FIBER_FNN_BIN` and `FIBER_UDT_INIT_BIN` paths use prebuilt
binaries installed read-only under the sandbox. Copy verified outputs into
`runtime/artifacts`, record their checksums, and apply
`fiber-external-binaries.patch` to the sandbox Fiber checkout before starting
it:

```bash
sudo install -o root -g root -m 0555 \
  "$FIBER_BUILD_CHECKOUT/target/debug/fnn" \
  /srv/fiber-public-demo/runtime/artifacts/fnn
sudo install -o root -g root -m 0555 \
  "$FIBER_BUILD_CHECKOUT/tests/deploy/udt-init/target/debug/udt-init" \
  /srv/fiber-public-demo/runtime/artifacts/udt-init
sha256sum /srv/fiber-public-demo/runtime/artifacts/{fnn,udt-init}
git -C /srv/fiber-public-demo/fiber apply --unidiff-zero \
  /srv/fiber-public-demo/fiber-paid-http/deploy/fiber-demo/fiber-external-binaries.patch
```

If those variables are omitted, the patched Fiber scripts retain their normal
Cargo build fallback inside the sandbox checkout.

Install the units and the HTTP virtual host:

```bash
sudo install -m 0755 deploy/fiber-demo/netns.sh \
  /usr/local/sbin/fiber-demo-netns
sudo install -m 0644 deploy/fiber-demo/systemd/*.service \
  /etc/systemd/system/
sudo install -m 0644 deploy/fiber-demo/nginx-http.conf \
  /etc/nginx/sites-available/fiber-demo.avato.online
sudo ln -sfn /etc/nginx/sites-available/fiber-demo.avato.online \
  /etc/nginx/sites-enabled/fiber-demo.avato.online
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl enable --now \
  fiber-demo-netns.service \
  fiber-demo-sandbox-network.service \
  fiber-demo-sandbox-api.service \
  fiber-demo-sandbox-web.service
sudo systemctl reload nginx
```

## Verification

The namespace address must be reachable from the host while its loopback RPC
ports remain absent from the host namespace:

```bash
curl -fsS http://10.203.0.2:8877/readyz | jq .
curl -fsSI http://10.203.0.2:8878/
ss -ltn | grep -E ':(8114|21714|21715|21716)\b'
sudo ip netns exec fiber-demo-sandbox \
  ss -ltn | grep -E ':(8114|21714|21715|21716)\b'
```

Use a different public session for every take:

```text
http://fiber-demo.avato.online/?sessionId=video-take-01&pollMs=1200
```

To reset only the public demo, stop its web, API and network services, remove
`/srv/fiber-public-demo/fiber-paid-http/.tmp` and
`/srv/fiber-public-demo/runtime/battlecode-demo.sqlite`, then start the three
services again. The network service's `REMOVE_OLD_STATE=y` recreates only the
sandbox CKB/Fiber state. Keep `runtime/artifacts` intact, and do not invoke the
existing deployment's reset or local-network scripts.
