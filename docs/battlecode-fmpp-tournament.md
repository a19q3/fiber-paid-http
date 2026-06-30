# FiberMPP Battlecode xUDT Tournament

This flow turns a local Battlecode match into a paid-entry tournament:

1. A player submits a Battlecode `RobotPlayer.java` source file.
2. FiberMPP locks that submission in the tournament ledger and returns `submissionId`, `botScriptHash`, and `clientHash`.
3. The player requests a Battlecode entry ticket with the locked submission id and hash commitments.
4. FiberMPP returns an HTTP 402 challenge that binds the entry request, submission id, and hash commitments.
5. The payer FNN settles the Fiber payment.
6. The gateway verifies settlement and issues `Payment-Receipt`.
7. The ticket is recorded with the receipt id, payment hash, and locked submission id.
8. The local Battlecode engine materializes that locked submission and runs it against `baselinebot`.
9. If the submitted bot wins, the tournament either records a local claimable xUDT prize award or, when explicitly enabled, pays the prize through a live Fiber xUDT payment.

The Battlecode engine is an external AGPL-3.0 dependency. Keep it outside this repository:

```bash
git clone --depth 1 https://github.com/battlecode/battlecode25-scaffold.git /home/arthur/a19q3/battlecode25-scaffold
```

The API runner does not copy Battlecode scaffold code into FiberMPP. It stores submitted bot sources under `.tmp/battlecode-tournament/submissions/`, records tournament state in a SQLite ledger, materializes each match under `.tmp/battlecode-tournament/runs/`, and runs `battlecode.server.Main` headlessly.

## Toolchain

Use JDK 21. A local user-level JDK is preferred:

```bash
export BATTLECODE_JDK_HOME=/home/arthur/a19q3/.toolchains/jdk-21.0.11+10
```

Use either a downloaded Battlecode engine jar:

```bash
export BATTLECODE_ENGINE_JAR=/home/arthur/a19q3/.toolchains/battlecode25/battlecode25-java-3.1.0.jar
export BATTLECODE_ENGINE_VERSION=3.1.0
```

or let the runner fall back to a cached Gradle jar if present.

## Live Fiber Prerequisites

Start the local Fiber network first. For the basic CKB payment lane:

```bash
bash scripts/fiber_local_network.sh up
```

For xUDT entry and prize payments, the Fiber local network must have UDT channels. Use the xUDT variant:

```bash
FIBER_LOCAL_ASSET=xudt \
FIBER_LOCAL_PRIZE_ROUTE=1 \
bash scripts/fiber_local_network.sh up
```

The local xUDT type script used by Fiber's dev network is:

```bash
export FIBER_ASSET=xUDT:BCODE
export FIBER_XUDT_TYPE_SCRIPT='{"code_hash":"0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95","hash_type":"data2","args":"0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947"}'
```

Then start the evidence API and web console with live Fiber enabled:

```bash
RUN_FIBER_E2E=1 \
FIBER_MODE=local \
FIBER_PAYEE_RPC_URL=http://127.0.0.1:21716 \
FIBER_PAYER_RPC_URL=http://127.0.0.1:21714 \
FIBER_ROUTER_RPC_URL=http://127.0.0.1:21715 \
FIBER_CURRENCY=Fibd \
FIBER_ASSET=xUDT:BCODE \
FIBER_XUDT_TYPE_SCRIPT='{"code_hash":"0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95","hash_type":"data2","args":"0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947"}' \
FIBER_E2E_AMOUNT_SHANNONS=100 \
FIBER_MPP_SECRET="$(openssl rand -hex 32)" \
EVIDENCE_API_PORT=8877 \
EVIDENCE_WEB_PORT=8878 \
FIBER_MPP_DEMO_SESSION=battlecode-live \
scripts/evidence_live_demo.sh start
```

Open:

```text
http://127.0.0.1:8878/?sessionId=battlecode-live&pollMs=1200
```

## Run The Full Tournament Flow

First lock the bot source. This command submits the bundled `fiberchamp` source and returns the hash commitments:

```bash
curl -sS -X POST http://127.0.0.1:8877/api/tournament/battlecode/submissions \
  -H 'content-type: application/json' \
  -H 'x-fiber-mpp-session: battlecode-live' \
  --data '{"playerId":"arthur","botPackage":"fiberchamp"}' | jq .
```

To submit a different strategy, pass a Java source string with a package matching `botPackage`:

```bash
jq -n --rawfile source ./RobotPlayer.java \
  '{playerId:"arthur", botPackage:"mybot", source:$source}' \
| curl -sS -X POST http://127.0.0.1:8877/api/tournament/battlecode/submissions \
  -H 'content-type: application/json' \
  -H 'x-fiber-mpp-session: battlecode-live' \
  --data @- | jq .
```

The submission response contains:

```text
submissionId   durable locked submission id
botScriptHash  sha256 of the submitted Battlecode RobotPlayer.java source
clientHash     sha256 commitment to the tournament runner module, Battlecode engine jar hash, engine version, submission id, and bot hash
runnerHash     sha256 of the running FiberMPP tournament runner module
engineHash     sha256 of the Battlecode engine jar
```

`pnpm battlecode:tournament` performs the submission step first, then requests the paid entry challenge. By default it submits the bundled `fiberchamp` source; set `BATTLECODE_BOT_SOURCE=/path/to/RobotPlayer.java` and `BATTLECODE_BOT=<java_package>` to submit another strategy:

```bash
EVIDENCE_API_BASE=http://127.0.0.1:8877 \
FIBER_MPP_TOURNAMENT_SESSION=battlecode-live \
BATTLECODE_PLAYER_ID=arthur \
BATTLECODE_BOT=fiberchamp \
BATTLECODE_XUDT_ASSET=xUDT:BCODE \
BATTLECODE_ENTRY_AMOUNT=100 \
BATTLECODE_PRIZE_AMOUNT=200 \
BATTLECODE_MAP=DefaultSmall \
pnpm battlecode:tournament
```

To require live Fiber xUDT prize payout, add:

```bash
BATTLECODE_AWARD_SETTLEMENT=fiber-xudt \
BATTLECODE_PRIZE_PAYER_RPC_URL=http://127.0.0.1:21716 \
BATTLECODE_PRIZE_PAYEE_RPC_URL=http://127.0.0.1:21714
```

In this mode the match endpoint fails closed if the prize invoice cannot be created, paid, and observed as settled. It does not silently fall back to the local award ledger.

The script writes:

```text
reports/battlecode-fmpp-tournament.json
```

The API ledger is:

```text
.tmp/battlecode-tournament-ledger.sqlite
```

Set a durable path explicitly for production-like runs:

```bash
BATTLECODE_LEDGER_PATH=/var/lib/fiber-mpp/battlecode-tournament-ledger.sqlite
```

The API also accepts `BATTLECODE_TOURNAMENT_LEDGER_PATH` for the same purpose. On first read, an old `.tmp/battlecode-tournament-ledger.json` file is imported into SQLite if the SQLite ledger is empty; the JSON file is left in place as migration evidence.

Locked submission sources are written under:

```text
.tmp/battlecode-tournament/submissions/
```

Battlecode replay files are written under:

```text
.tmp/battlecode-tournament/matches/
```

## Runner Isolation

The tournament runner always materializes the locked submission into a per-ticket run directory, recalculates the source hash before compilation, uses a controlled Java environment, and enforces a process timeout.

By default, when `/usr/bin/prlimit` is available, match compilation and execution run in `prlimit-local` mode:

```text
BATTLECODE_SANDBOX_MODE=prlimit-local
```

This records CPU and address-space limits in the report. It does not claim full filesystem or network namespace isolation; reports mark the filesystem boundary as `run-dir-only-by-convention` and network as `not-granted`.

The default address-space limit is 8 GiB because the Java 21 VM and Battlecode instrumenter reserve large virtual address ranges even with a small `-Xmx`. Override it only after testing:

```bash
BATTLECODE_SANDBOX_MEMORY_BYTES=8589934592
BATTLECODE_SANDBOX_CPU_SECONDS=125
```

For stricter local experiments, set:

```bash
BATTLECODE_SANDBOX_MODE=bubblewrap-prlimit
```

That mode requires `/usr/bin/bwrap` and `/usr/bin/prlimit`, unshares networking, bind-mounts the run directory writable, and keeps the rest of the root filesystem read-only. It is intentionally opt-in because some Battlecode/JDK combinations are slower or stricter under Bubblewrap.

## Evidence Boundary

Real today:

- HTTP 402 challenge for tournament entry.
- Durable SQLite bot submission/ticket/match/award ledger with `submissionId`, source path, source byte length, source hash, policy metadata, and lock timestamp.
- Paid challenge metadata includes the locked submission id, committed bot source hash, and tournament client hash.
- Real Fiber payment when local/testnet Fiber env is configured.
- `Payment-Receipt` issued by the FiberMPP gateway.
- Ticket issuance stores the same submission id and hash commitments and rejects mismatches.
- Match execution materializes the locked source into an isolated run directory, recalculates the source hash and runner/client hash before running, enforces process limits when available, and fails closed on mismatch.
- Battlecode headless match execution.
- Deterministic local match hash that includes the fairness verification record and replay bytes.
- xUDT prize award recorded in a local claimable award ledger by default.
- Live Fiber xUDT prize payout when `BATTLECODE_AWARD_SETTLEMENT=fiber-xudt` and UDT Fiber channels are configured.

Not yet real:

- On-chain xUDT payout transaction construction/signing/broadcast.
- CKB L1 xUDT winner address validation and direct on-chain transfer custody.
- Multi-player bracket scheduling beyond the current one-ticket local match.

The report intentionally marks local awards as `settlement: "local-xudt-award-ledger"` and live Fiber awards as `settlement: "fiber-xudt-payment"` so neither path is confused with a broadcast CKB L1 transaction.
