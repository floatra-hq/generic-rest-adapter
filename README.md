# Floatra Generic REST Adapter (Mode B)

Configuration-driven middleware that connects any ERP with outbound HTTP capability to the Floatra Integration Gateway. **No ERP-specific code** — distributors author a single JSON config and the adapter handles the rest.

- **Source:** [`github.com/floatra-hq/generic-rest-adapter`](https://github.com/floatra-hq/generic-rest-adapter) (MIT), a read-only mirror; each release is a git tag `v<version>` with a source zip + `.sha256` on its [Releases page](https://github.com/floatra-hq/generic-rest-adapter/releases).
- **Image:** `ghcr.io/floatra-hq/generic-rest-adapter:<version>`, built from that same tag. Git tags carry a `v` (`v0.1.0`); image tags do not (`0.1.0`), the usual convention for each.

Implements **Prompt 3** of the ERP Integration Spec. Designed for Sage 300, Dynamics 365, FieldAssist, and any system that can POST a webhook + receive one back.

---

## Quick start (distributor)

The image is `ghcr.io/floatra-hq/generic-rest-adapter` (linux/amd64 and
linux/arm64), tagged with each release version (see `CHANGELOG.md`) and
`latest`. Pin a version in production; never run `latest`. Only pull from
`ghcr.io/floatra-hq`: anything under another owner is not from Floatra.

```bash
# 1. Start from the example config bundled in the image
mkdir -p configs
docker run --rm ghcr.io/floatra-hq/generic-rest-adapter:0.1.0 \
  cat /app/configs.example/example.json > configs/my-platform.json
chmod 600 configs/my-platform.json   # the adapter refuses group/world-readable configs

# 2. Edit it (see §"Authoring a config")

# 3. Validate before running (no server, no network; exits non-zero on any problem)
docker run --rm -v "$PWD/configs:/configs:ro" -e CONFIG_DIR=/configs \
  ghcr.io/floatra-hq/generic-rest-adapter:0.1.0 \
  node dist/main.js --validate-only

# 4. Run it (the named volume keeps the fallback audit log across restarts)
docker run -d \
  -v "$PWD/configs:/configs:ro" \
  -v floatra-adapter-audit:/var/lib/floatra-adapter \
  -e CONFIG_DIR=/configs \
  -e ALLOW_FALLBACK_ON_CREDIT_OVERRIDE=false \
  -p 3100:3100 \
  ghcr.io/floatra-hq/generic-rest-adapter:0.1.0
```

Every fallback decision taken while Floatra is unreachable is appended to
`/var/lib/floatra-adapter/fallback-audit.jsonl` (the image's
`FALLBACK_AUDIT_LOG_PATH`; override it with `-e FALLBACK_AUDIT_LOG_PATH=...`).
That directory is writable by the container's `adapter` user but lives in the
container's writable layer, so **mount a volume on it** (as above) or the log
is lost when the container is replaced. A bind mount must be writable by the
container user (uid of `adapter`, or run with `--user`).

The container runs as a non-root `adapter` user, so the mounted config files
must be readable by it (owner-only `0600` files owned by that uid, or run with
`--user "$(id -u):$(id -g)"` so the container user owns them).

For a fully pinned deployment, pull by digest (printed with every release and
shown on the package page); a digest cannot be re-pointed the way a tag can:

```bash
docker pull ghcr.io/floatra-hq/generic-rest-adapter@sha256:<digest>
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  ghcr.io/floatra-hq/generic-rest-adapter@sha256:<digest>
```

The adapter exposes:

| Endpoint | Purpose |
|---|---|
| `POST /adapter/:platformId/inbound` | ERP posts its native event here |
| `POST /adapter/:platformId/floatra-webhook` | Floatra gateway posts events here |
| `GET  /adapter/health` | Process-level liveness |
| `GET  /adapter/:platformId/health` | Per-platform + gateway round-trip |
| `GET  /adapter/:platformId/config/validate` | Re-run the validator |

---

## Authoring a config

Each platform is one JSON file under `CONFIG_DIR`, named anything (we recommend `<platform_id>.json`). The adapter loads every `*.json` at startup and validates each — invalid configs abort boot with a precise error list.

### Mandatory structural guard

`outbound.on_reorder_locked.block_merchant_orders` **must be `true`**. The validator refuses any config that sets it false. This is the contract that lets Floatra emit `merchant.reorder_locked` knowing the distributor's ERP will actually block new orders — without it, a merchant could simply order from the same distributor again and bypass the lock.

### Inbound `trigger_events[].condition` grammar

Conditions are evaluated by a **safe-subset parser** — never by JavaScript. The grammar:

```
expr      := term ( ('&&' | '||') term )*
term      := operand op operand
operand   := jsonpath | string | number | true | false | null
op        := == | != | > | < | >= | <=
```

Examples that work:
- `$.Status == 'Pending'`
- `$.Order.Total > 10000 && $.Order.PaymentMethod == 'Credit'`
- `$.State == 'AWAITING_CREDIT' || $.State == 'CREDIT_REQUESTED'`

Examples that are rejected at startup:
- `($.A == 'x')` — parentheses are not in the grammar
- `$.foo() == 1` — function-call syntax
- `$.A == 'x'; sideEffect()` — semicolons / statement chaining

If your condition needs more than the supported operators, surface the decision through a flag in the ERP payload — don't try to encode logic in the condition string.

### Field mappings

Each value is a [JSONPath](https://github.com/json-path/JsonPath) expression resolved against the inbound payload:

```json
"field_mappings": {
  "external_order_id":    "$.OrderHeader.OrderId",
  "external_merchant_id": "$.OrderHeader.CustomerCode",
  "amount":               "$.OrderHeader.Total",
  "amount_unit":          "NAIRA",
  "category":             "$.OrderHeader.CustomerGroup"
}
```

`amount_unit` is mandatory: `NAIRA` or `KOBO` — it tells the adapter how to read your ERP's amount. The translator enforces a ₦10,000 floor and ₦15M ceiling, then sends the amount to Floatra as a **decimal-Naira string** (e.g. `"250000.00"`) — see [Floatra contract](#floatra-contract).

`category` may be a JSONPath OR a static value. Either way it must resolve to a key in `category_mappings`, which maps your ERP's category name to a Floatra order category: one of `FMCG`, `ELECTRONICS`, `FASHION`, `AGRICULTURE`, `PHARMACY`, `OTHER`. The validator rejects any other value at startup.

---

## Floatra contract

What the adapter sends to, and accepts from, Floatra core. The fixtures that pin this live in `src/contract/fixtures/` and are **rendered by core**, not hand-written. Floatra regenerates them in its private monorepo after any core change to the partner contract (the public mirror receives them with each release), by running, at the monorepo root:

```bash
UPDATE_CONTRACT_FIXTURES=1 npx jest src/modules/partner-webhooks/partner-contract-fixtures.spec.ts
```

`src/contract/example-config.e2e.spec.ts` replays those fixtures through the real webhook controller and outbound translator using `configs/example.json`, so a drift between core and the shipped example fails the adapter's tests.

### Gateway base URL

`floatra_gateway_url` is the partner API base and **must end in `/v1/partner`** — `https://api.floatra.com/v1/partner` in production. The adapter appends `/orders/initiate`, `/orders/by-external-id/:id`, `/orders/:loanId/confirm-delivery`, `/orders/:loanId/cancel`, `/platform/health`, and `/webhooks/...`. The validator rejects any other base.

### Money

Every amount the adapter sends or receives is a **decimal-Naira string** with 2 decimal places (`"250000.00"`) — never a JS number, never kobo.

### Order categories

`category_mappings` values must be one of: `FMCG`, `ELECTRONICS`, `FASHION`, `AGRICULTURE`, `PHARMACY`, `OTHER`.

### Responses and errors

Core wraps successful responses in an envelope; the adapter unwraps it. Error responses pass through intact: `error` is a human-readable message and `errorCode` a machine code (e.g. `ORDER_NOT_FOUND`) for programmatic handling. Treat the HTTP status as authoritative and `errorCode` as the detail — a few generic failures (e.g. request validation) still carry `errorCode: null`.

### Webhooks from Floatra

Headers:

| Header | Meaning |
|---|---|
| `X-Floatra-Signature` | hex `HMAC-SHA256(webhook_secret, X-Floatra-Timestamp + "." + rawBody)` |
| `X-Floatra-Timestamp` | **unix seconds** (e.g. `1790856000`); rejected if more than 5 minutes from the adapter's clock |
| `X-Floatra-Event-ID` | delivery id; used for dedup |
| `X-Floatra-Delivery-Attempt` | 1-based retry counter (informational) |

Invalid signature or stale timestamp → 403. A **duplicate** event id is answered **200** `{ "accepted": true, "duplicate": true }` — core treats any non-2xx as a failed delivery and would otherwise retry it until dead-lettered.

The body is a **flat camelCase** JSON object. The adapter wraps it as `{ event_id, event_type, occurred_at, data: <body> }`, so `outbound.event_mappings[*].field_mappings` address core fields as **`$.data.<field>`** (e.g. `$.data.externalOrderId`).

| Event | Fields |
|---|---|
| `order.credit_approved` | `event`, `loanId`, `loanRequestId`, `merchantId`, `merchantExternalId`, `externalOrderId`, `amount`, `principalAmount`, `interestAmount`, `totalRepayment`, `tenureDays` (number), `dueDate`, `timestamp` |
| `order.disbursed` | `event`, `loanId`, `merchantId`, `merchantExternalId`, `externalOrderId`, `amount`, `transferCode`, `disbursedAt`, `timestamp` |
| `merchant.reorder_locked` | `event`, `merchantId`, `merchantExternalId`, `reason`, `timestamp` |
| `merchant.reorder_unlocked` | `event`, `merchantId`, `merchantExternalId`, `reason`, `timestamp` |
| `order.repayment_due` | `event`, `loanId`, `merchantId`, `amount` (the loan **principal**), `outstandingAmount` (what is **due**), `dueDate`, `daysUntilDue` (number), `timestamp` |

Every event also carries `version`, `livemode` (boolean) and `platformId` (your platform). On `order.repayment_due`, **`amount` is the loan principal** (kept for compatibility); map **`$.data.outstandingAmount`** wherever you show the amount due — principal + interest + late fees, less what was paid or refunded. Deliveries queued before 2026-10-08 lack `outstandingAmount`.

Money fields (`amount`, `principalAmount`, `interestAmount`, `totalRepayment`, `outstandingAmount`) are decimal-Naira strings; dates are ISO-8601. `merchantExternalId` / `externalOrderId` are **your** ids, as you sent them on the order. They are not always present: `externalOrderId` is absent when the loan did not originate from your `/v1/partner/orders/initiate` call (e.g. a checkout-widget or offline order) or the order belongs to another platform, and `merchantExternalId` is absent when the merchant has no active link to your platform. A field mapping that reads an absent field (e.g. `$.data.externalOrderId`) is **omitted** from the body sent to your ERP (an unmatched JSONPath yields no value, and the key is dropped on serialisation) — so your ERP must treat that field as optional.

The reorder events go through `on_reorder_locked` / `on_reorder_unlocked`, not `event_mappings`. The ERP body carries `merchant_external_id` (your customer id, or `null` if Floatra has none) so the ERP knows **which** customer to block or unblock, alongside the raw `data`.

---

## Deployment topology

The adapter is **multi-tenant** — one process can serve many distributors by putting their configs in the same directory. Restrict via `ENABLED_PLATFORM_IDS` if you want to deploy the same image with a subset:

```
ENABLED_PLATFORM_IDS=plat_001,plat_002
```

Two valid hosting models:

1. **Distributor-hosted** — the adapter runs inside the distributor's network alongside their ERP. Floatra never sees their ERP credentials. Recommended for Dynamics 365 / on-prem Sage installs.
2. **Floatra-hosted (multi-tenant)** — Floatra runs the adapter; the distributor configures via the Floatra dashboard. Simpler operationally; requires the distributor to share their ERP webhook URL + auth key.

Either way, the adapter holds two secret kinds:
- `api_key` — talks to the Floatra gateway. Per-platform.
- `webhook_secret` — verifies HMAC on outbound webhooks from Floatra. Per-platform.

`outbound.erp_auth` is the credential the adapter uses to POST translated events into the ERP. Belongs to the distributor; never sent to Floatra.

---

## Security model

| Surface | Defence |
|---|---|
| Trigger condition strings | Safe-subset parser, no `Function`/`eval`/`vm` |
| JSONPath operands | Restricted character set; script-block characters rejected |
| Outbound webhooks from Floatra | HMAC-SHA256 over `X-Floatra-Timestamp + "." + raw body` via `webhook_secret`, timing-safe compare; ±5 min timestamp window; event-id dedup |
| Inbound from ERP | Per-platform `inbound.auth` (api_key / basic / hmac) |
| `unavailability_fallback=ALLOW_ON_CREDIT` | Requires `ALLOW_FALLBACK_ON_CREDIT_OVERRIDE=true` env var as a second gate |
| `on_reorder_locked.block_merchant_orders` | Validator rejects `false` at startup; translator double-checks at request time |
| Config files | Should be 0600, owned by the adapter user; never checked into git (the example is the only committed one) |

---

## Local development

```bash
npm install
cp .env.example .env
cp configs/example.json configs/plat_dev.json
# edit plat_dev.json with sandbox values, then:
npm run start:dev
```

Tests:

```bash
npm test          # condition evaluator, validator, translators, HMAC verifier, and the core contract e2e
```

The four highest-value test suites are `src/config/condition-evaluator.spec.ts` (grammar safety), `src/config/config-validator.service.spec.ts` (reorder-lock guard), `src/translators/inbound-translator.service.spec.ts` (Sage / Dynamics / FieldAssist payload shapes), and `src/webhook/inbound-hmac.spec.ts` (HMAC-SHA256 verification).

---

## What's NOT in the scaffold yet (deferred to pilot)

All scaffold-time deferred items have now landed. The adapter
implements every trigger action + response mode the spec defines.

Possible future enhancements (not currently in scope):
- Map ERP-specific cancel reasons to Floatra's `reason_code` enum
  (currently defaults to `DISTRIBUTOR / OTHER`)
- HMAC-signed callbacks: today the callback POST uses
  `outbound.erp_auth` (api_key / basic / none). HMAC signing on
  the callback body would match the inbound path's HMAC contract
  for symmetry.

> **Update 2026-05-12 (a):** Inbound HMAC auth is now wired (was previously parsed-but-accepted). `verifyInboundHmac` performs an HMAC-SHA256 + timing-safe compare against `req.rawBody`, accepts both raw-hex and `sha256=`-prefixed signature shapes, and rejects with 403 `INBOUND_AUTH_FAILED` on mismatch. See `src/webhook/inbound-hmac.ts` + `inbound-hmac.spec.ts`.

> **Update 2026-05-12 (b):** Floatra-gateway boot-time reachability check is now real. On startup the loader pings every loaded platform's `<floatra_gateway_url>/platform/health` (i.e. `https://api.floatra.com/v1/partner/platform/health`) with a 10s timeout per platform. Behaviour:
> - Default: failures log a warning, boot continues
> - `STRICT_GATEWAY_HEALTHCHECK=true`: any failure aborts boot with a precise error listing each unreachable platform — catches misconfigured URLs or network rules at deploy time
>
> See `src/config/config-loader.service.ts` + `config-loader.service.spec.ts`.

> **Update 2026-05-12 (c):** `confirm_delivery` and `cancel_order` trigger actions are wired end-to-end (closes #45). The controller uses the new core endpoint `GET /v1/partner/orders/by-external-id/:externalOrderId` to resolve the loan id, then calls the per-action endpoint. Cancel defaults to `cancelled_by: DISTRIBUTOR, reason_code: OTHER` — distributors that want ERP-specific reason mapping can configure that as a follow-up.

> **Update 2026-05-12 (d):** Callback-mode response delivery is wired (closes #46). `response_mode: callback` now responds 202 to the ERP synchronously and POSTs the decision envelope to `inbound.callback_url` asynchronously via `ErpDeliveryService.deliverToUrl`. Same 5xx/4xx retry policy as the standard outbound webhook path. Callback delivery failures don't crash the request (it already returned 202) — they're logged for ops replay.
