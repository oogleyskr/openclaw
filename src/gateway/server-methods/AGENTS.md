# Gateway Server Methods

RPC handler implementations for the OpenClaw gateway. Each file owns a named group of methods (e.g. `chat.ts` → `chat.send`, `chat.history`, `chat.abort`, `chat.inject`).

## Architecture

All handlers aggregated by `src/gateway/server-methods.ts`, which:

1. Imports every `*Handlers` export from this directory
2. Merges into `coreGatewayHandlers` (flat `Record<string, GatewayRequestHandler>`)
3. Dispatches via `handleGatewayRequest()` — auth + rate-limiting before calling handler

## Handler Interface

```ts
type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
// opts: { req, params, client, isWebchatConnect, respond, context }
```

## Key Patterns

**Validation first:** `assertValidParams(params, validator, methodName, respond)` from `validation.ts`

**Idempotency:** `agent`, `chat.send`, `send` all check `context.dedupe.get(key)` before work

**Fire-and-forget with ack:** `agent` and `chat.send` immediately `respond(true, { runId, status: "started" })` then run async. A second `respond` with final result is sent for `expectFinal:true` clients.

**Broadcast:** `context.broadcast("event", payload)` → all clients. `context.nodeSendToSession(sessionKey, event, payload)` → specific node.

## Critical Rules

- **Transcript writes MUST use `appendInjectedAssistantMessageToTranscript()`** from `chat-transcript-inject.ts`. Raw `fs.appendFileSync` to transcripts is forbidden — severs the `parentId` DAG chain for compaction/history. Enforced by test in `server-methods.test.ts`.
- **`exec-approval.ts` is a factory** — call `createExecApprovalHandlers(manager, opts)`, not a static export.
- **Control-plane write methods** (`config.apply`, `config.patch`, `update.run`) are rate-limited (3/60s) and trigger SIGUSR1 restarts via sentinel file.

## Adding a Handler

1. Create `src/gateway/server-methods/your-domain.ts` exporting `const yourHandlers: GatewayRequestHandlers`
2. Import + spread into `coreGatewayHandlers` in `src/gateway/server-methods.ts`
3. Add method schema to `src/gateway/protocol/`
4. If custom scopes needed: update `src/gateway/method-scopes.ts`

## Tests

Vitest. Most tests call handlers directly with `GatewayRequestHandlerOptions` shape (no full server). Main: `server-methods.test.ts`. Domain tests colocated (e.g. `chat.abort-persistence.test.ts`).
