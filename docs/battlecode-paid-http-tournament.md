# Fiber Paid HTTP Battlecode xUDT Tournament

This flow turns a local Battlecode match into a paid-entry tournament:

1. A player submits a Battlecode `RobotPlayer.java` source file.
2. Fiber Paid HTTP locks that submission in the tournament ledger and returns `submissionId`, `botScriptHash`, and `clientHash`.
3. The player requests a Battlecode entry ticket with the locked submission id and hash commitments.
4. Fiber Paid HTTP returns an HTTP 402 challenge that binds the entry request, submission id, and hash commitments.
5. The payer FNN settles the Fiber payment.
6. The gateway verifies settlement and issues `Payment-Receipt`.
7. The ticket is recorded with the receipt id, payment hash, and locked submission id.
8. The local Battlecode engine materializes that locked submission and runs it against `baselinebot`.
9. If the submitted bot wins, the tournament either records a local claimable xUDT prize award or, when explicitly enabled, pays the prize through a live Fiber xUDT payment.

The Battlecode engine is an external AGPL-3.0 dependency. Keep it outside this repository. The setup command clones the scaffold into the parent directory when needed, discovers JDK 21+, and builds the pinned engine:

```bash
pnpm battlecode:setup
```

The equivalent manual setup is:

```bash
git clone --depth 1 https://github.com/battlecode/battlecode25-scaffold.git ../battlecode25-scaffold
export BATTLECODE_DIR="$(cd ../battlecode25-scaffold/java && pwd)"
```

The API also discovers `../battlecode25-scaffold/java` (including the equivalent path from a repository worktree). `/api/tournament/battlecode/status` reports the resolved path and fails visibly when the scaffold is absent.

The API runner does not copy Battlecode scaffold code into Fiber Paid HTTP. It stores submitted bot sources under `.tmp/battlecode-tournament/submissions/`, records tournament state in a SQLite ledger, materializes each match under `.tmp/battlecode-tournament/runs/`, and runs `battlecode.server.Main` headlessly.

## Toolchain

Use JDK 21 or newer. The runner automatically discovers a compatible JDK on `PATH`; set an explicit home when recording reproducible evidence:

```bash
export BATTLECODE_JDK_HOME=/path/to/jdk-21-or-newer
```

The pinned scaffold currently declares engine version `1.0.0` in `java/engine_version.txt`. Build it with JDK 21 or newer so Gradle resolves the matching engine jar:

```bash
cd "$BATTLECODE_DIR"
./gradlew version
./gradlew build
```

The runner discovers the matching Gradle cache entry. To use an independently provisioned jar instead, set both values explicitly:

```bash
export BATTLECODE_ENGINE_JAR=/absolute/path/to/battlecode25-java-1.0.0.jar
export BATTLECODE_ENGINE_VERSION=1.0.0
```

The status endpoint checks scaffold files, an actual JDK 21+ home, the exact engine jar, Fiber payment configuration, and prize settlement mode separately. A cloned scaffold alone is not reported as a runnable match engine.

Before a recording, run the real headless engine smoke:

```bash
pnpm battlecode:engine-smoke
```

This compiles the bundled bot, runs `DefaultSmall` against `baselinebot`, verifies the fairness commitments, and checks that a non-empty replay was written. It deliberately marks payment execution as `not-exercised`; it is not a substitute for the live paid tournament flow below.

For the complete recording environment, the recommended entrypoint is:

```bash
pnpm battlecode:demo:start
```

It performs the setup and engine smoke, starts or reuses the forward xUDT Fiber network, and launches the live Dashboard. Use `pnpm battlecode:demo:stop` after recording.

## Live Fiber Prerequisites

Start the local Fiber network first. For the basic CKB payment lane:

```bash
bash scripts/fiber_local_network.sh up
```

For the recording lane, use forward xUDT channels for the paid entry and keep the prize as an explicitly labeled local ledger award:

```bash
FIBER_LOCAL_ASSET=xudt \
bash scripts/fiber_local_network.sh up
```

`FIBER_LOCAL_PRIZE_ROUTE=1` also creates reverse funding channels for experimental live prize payout. Do not add it to the critical recording path unless the resulting parallel-channel topology has passed an end-to-end routing check with the pinned FNN build. The reliable submission story is real Fiber xUDT entry settlement followed by a local claimable prize record.

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
FIBER_PAID_HTTP_SECRET="$(openssl rand -hex 32)" \
EVIDENCE_API_PORT=8877 \
EVIDENCE_WEB_PORT=8878 \
FIBER_PAID_HTTP_DEMO_SESSION=battlecode-live \
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
  -H 'x-fiber-paid-http-session: battlecode-live' \
  --data '{"playerId":"arthur","botPackage":"fiberchamp"}' | jq .
```

To submit a different strategy, pass a Java source string with a package matching `botPackage`:

```bash
jq -n --rawfile source ./RobotPlayer.java \
  '{playerId:"arthur", botPackage:"mybot", source:$source}' \
| curl -sS -X POST http://127.0.0.1:8877/api/tournament/battlecode/submissions \
  -H 'content-type: application/json' \
  -H 'x-fiber-paid-http-session: battlecode-live' \
  --data @- | jq .
```

The submission response contains:

```text
submissionId   durable locked submission id
botScriptHash  sha256 of the submitted Battlecode RobotPlayer.java source
clientHash     sha256 commitment to the tournament runner module, Battlecode engine jar hash, engine version, submission id, and bot hash
runnerHash     sha256 of the running Fiber Paid HTTP tournament runner module
engineHash     sha256 of the Battlecode engine jar
```

`pnpm battlecode:tournament` performs the submission step first, then requests the paid entry challenge. By default it submits the bundled `fiberchamp` source; set `BATTLECODE_BOT_SOURCE=/path/to/RobotPlayer.java` and `BATTLECODE_BOT=<java_package>` to submit another strategy:

```bash
EVIDENCE_API_BASE=http://127.0.0.1:8877 \
FIBER_PAID_HTTP_TOURNAMENT_SESSION=battlecode-live \
BATTLECODE_PLAYER_ID=arthur \
BATTLECODE_BOT=fiberchamp \
BATTLECODE_XUDT_ASSET=xUDT:BCODE \
BATTLECODE_ENTRY_AMOUNT=100 \
BATTLECODE_PRIZE_AMOUNT=200 \
BATTLECODE_MAP=DefaultSmall \
pnpm battlecode:tournament
```

To test optional live Fiber xUDT prize payout outside the critical recording path, add:

```bash
BATTLECODE_AWARD_SETTLEMENT=fiber-xudt \
BATTLECODE_PRIZE_PAYER_RPC_URL=http://127.0.0.1:21716 \
BATTLECODE_PRIZE_PAYEE_RPC_URL=http://127.0.0.1:21714
```

In this mode the match endpoint fails closed if the prize invoice cannot be created, paid, and observed as settled. It does not silently fall back to the local award ledger.

The script writes:

```text
reports/battlecode-paid-http-tournament.json
```

The API ledger is:

```text
.tmp/battlecode-tournament-ledger.sqlite
```

Set a durable path explicitly for production-like runs:

```bash
BATTLECODE_LEDGER_PATH=/var/lib/fiber-paid-http/battlecode-tournament-ledger.sqlite
```

The API also accepts `BATTLECODE_TOURNAMENT_LEDGER_PATH` for the same purpose. The file must be a new schema-versioned SQLite database; unsupported schema versions fail closed.

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
- `Payment-Receipt` issued by the Fiber Paid HTTP gateway.
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
