# PayPal integration

Framvera pays suppliers through real PayPal sandbox orders. PayPal is the authority for money: a payment counts as captured or refunded only when PayPal's API says so, and every record shown in the product carries PayPal's own ids, statuses and debug ids.

Package: `packages/paypal` (`@framvera/paypal`). Sources were read on 2026-11-12; behaviour marked **observed** was confirmed against the live sandbox the same day.

## Shape

```
PaymentIntent (economic)      packages/paypal/src/payments.ts   authority check, state, reconcile, locks
        |
PaymentsGateway (interface)   packages/paypal/src/gateway.ts
        |
PayPalGateway                 packages/paypal/src/core.ts       request ids, wire bodies, parsing, invariants
   |                 |
SdkPort (real)    FakePayPal (tests only, ids start with FAKE)
   |
@paypal/paypal-server-sdk 2.5.0  Orders v2, Payments v2
plain HTTPS                      OAuth token cache, verify-webhook-signature
```

The real adapter and the test fake share every line above the port, so the request-id, parsing, amount and reconciliation logic that tests exercise is the same code that talks to PayPal.

### Why the official server SDK

`@paypal/paypal-server-sdk` covers every Orders v2 and Payments v2 call Framvera makes (`createOrder`, `getOrder`, `captureOrder`, `authorizeOrder`, `captureAuthorizedPayment`, `voidPayment`, `refundCapturedPayment`, `getCapturedPayment`, `getRefund`) and exposes `PayPal-Request-Id`, `Prefer` and `PayPal-Mock-Response` as typed parameters. Its responses keep the raw body and headers, so Framvera parses PayPal's wire JSON directly and records `Paypal-Debug-Id` from every response. Automatic retries are disabled (`maxNumberOfRetries: 0`) because a blind retry of a money call is exactly what reconciliation exists to prevent.

The SDK has no webhooks controller, so signature verification is one plain HTTPS call. The SDK's OAuth is fed from Framvera's own token cache through `oAuthTokenProvider`, so both paths share one token.

## Environment

| Variable | Use |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials. Server only. |
| `PAYPAL_ENV` | `sandbox` (default). `live` is refused unless code also passes `allowLive`, and stays gated while payment records are typed sandbox-only. |
| `PAYPAL_WEBHOOK_ID` | Id of the webhook registered for this app. Without it, verification answers `NOT_CONFIGURED`. |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | Optional pages PayPal sends the buyer back to after approving or cancelling. |

Base URL: `https://api-m.sandbox.paypal.com`. Token: `POST /v1/oauth2/token`, HTTP Basic with the client id and secret, body `grant_type=client_credentials`; the response's `expires_in` drives the cache, which refreshes two minutes early and lets concurrent callers share one request.

## Creating an order

One payment intent becomes one order with one purchase unit, `intent: CAPTURE`, and one item per obligation at its exact amount:

```json
{
  "intent": "CAPTURE",
  "purchase_units": [{
    "reference_id": "agr_...",
    "custom_id": "pay_...",
    "invoice_id": "<operationKey>",
    "amount": { "currency_code": "SEK", "value": "1234.50",
                "breakdown": { "item_total": { "currency_code": "SEK", "value": "1234.50" } } },
    "items": [
      { "name": "Print inserts", "quantity": "1", "sku": "obl_..._print",
        "unit_amount": { "currency_code": "SEK", "value": "800.00" }, "category": "PHYSICAL_GOODS" },
      { "name": "Kit assembly", "quantity": "1", "sku": "obl_..._assembly",
        "unit_amount": { "currency_code": "SEK", "value": "434.50" }, "category": "PHYSICAL_GOODS" }
    ]
  }],
  "payment_source": { "paypal": { "experience_context": {
    "brand_name": "Framvera", "shipping_preference": "NO_SHIPPING", "user_action": "PAY_NOW",
    "return_url": "...", "cancel_url": "..." } } }
}
```

- `reference_id` is the obligation id when the payment covers one obligation, otherwise the agreement id. `sku` carries each obligation id.
- `custom_id` is the payment intent id; `invoice_id` is the operation key. PayPal keeps invoice ids unique per merchant by default, so a second attempt to bill the same operation is rejected by PayPal as well as by Framvera.
- `payee` is sent only when it is a syntactically valid PayPal merchant id (13 characters, `^[2-9A-HJ-NP-Z]{13}$`) or email. Synthetic suppliers have no PayPal accounts, so their payments go to the app's own sandbox business account, and the record says which merchant PayPal assigned.
- Amounts are integer minor units converted to PayPal's decimal strings without floating point (`123450` SEK becomes `"1234.50"`). Values with more precision than the currency allows are rejected on the way back.
- The charged amount must equal the economic amount unless a stated exchange rate is attached. Items must sum to the charge exactly. The buyer's recorded authority (`mayPreparePayments`, `maxSpend`) is checked in code before any order is created.

SEK is a PayPal REST currency with two decimals (currency codes reference). **Observed:** SEK orders create, approve, capture and refund in this sandbox app, and PayPal's checkout shows "1 234,50 SEK".

## Idempotency

Every mutating call carries `PayPal-Request-Id = requestIdFor(operationKey, step)`: a UUID-shaped SHA-256 of the payment's durable operation key and the step (`create`, `capture`, `authorize`, `capture-authorization`, `void`, `refund:<n>`).

- Deterministic, so a retry after a crash or timeout sends the same id.
- Distinct per step, because PayPal scopes idempotency per call type, and each partial refund on one capture needs its own key.
- 36 characters, inside PayPal's 38 character guidance.

PayPal stores Orders keys for 6 hours by default (SDK reference: extendable to 72 hours by account manager). A repeated request returns the stored result instead of executing again. **Observed:** replaying the capture with the same id returned HTTP 200 and the same capture id; the first capture returned 201.

## State model

PayPal statuses are stored verbatim; the internal state is derived from them:

| PayPal | Internal |
|---|---|
| order `CREATED` / `PAYER_ACTION_REQUIRED` with approval link | `PAYER_ACTION_REQUIRED` |
| order `APPROVED` | `APPROVED` |
| capture `COMPLETED` | `CAPTURE_COMPLETED` |
| capture `PENDING` | `CAPTURE_PENDING` (reason kept, e.g. `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`) |
| capture `DECLINED` / `FAILED`, or 422 `INSTRUMENT_DECLINED` | `CAPTURE_DENIED` |
| latest refund `COMPLETED` / `PENDING` / `FAILED` or `CANCELLED` | `REFUND_COMPLETED` / `REFUND_PENDING` / `REFUND_DENIED` |
| authorization or order `VOIDED` | `VOIDED` |

A `COMPLETED` order is not proof of payment on its own: PayPal's reference says to check `purchase_units[].payments.captures[].status`, which is what the derivation reads.

## Failures and reconciliation

| Outcome | Meaning | Handling |
|---|---|---|
| timeout, network error, 5xx, 202, 409 | PayPal may or may not have executed | `*_UNKNOWN`; `GET /v2/checkout/orders/{id}` before anything else, then retry only with the same request id |
| 429 `RATE_LIMIT_REACHED` | not executed | state unchanged, `retryAfterMs` surfaced |
| 422 `INSTRUMENT_DECLINED` | buyer's funding refused | `CAPTURE_DENIED`; the buyer can approve again with another source |
| 422 `ORDER_NOT_APPROVED` | buyer has not approved | `PAYER_ACTION_REQUIRED` |
| 422 `ORDER_ALREADY_CAPTURED` | an earlier attempt succeeded | reconcile from the order |
| 422 `REFUND_AMOUNT_EXCEEDED` and other refund 422s | refused | `REFUND_DENIED` |

`reconcile(pi, gateway)` derives state from a fresh order retrieval alone. The order view includes `payments.captures`, `payments.authorizations` and `payments.refunds` (**observed** for refunds), so one GET settles an unknown capture or refund. Order creation has no lookup by invoice, so an unknown create is resolved by replaying the same request id, which returns the order PayPal already made.

Money operations on one payment are serialised in process, and every captured amount is compared with the charge; a mismatch raises instead of being recorded.

## Refunds, authorizations, voids

- `POST /v2/payments/captures/{id}/refund`: empty body refunds the remainder, an `amount` refunds part. Framvera checks currency and `amount <= captured - completed or pending refunds` before calling, and PayPal enforces the same bound.
- `intent: AUTHORIZE` is supported for holds: authorize, capture the authorization (`final_capture: true`), or void it. PayPal's reference: authorizations are best captured within a three-day honor period and remain capturable for up to 29 days. A hold is not escrow, and a captured payment is refunded, never voided.

## Webhooks

`POST /v1/notifications/verify-webhook-signature` with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from the `PAYPAL-*` headers), `webhook_id` and `webhook_event`. PayPal requires `webhook_event` exactly as received, so Framvera embeds the raw body verbatim instead of re-serialising it.

- PayPal retries a delivery up to 25 times over 3 days until it gets a 2xx, so `WebhookInbox` dedupes by event id.
- Events only say what to re-check. `webhookHint(event)` extracts the order, capture or refund id, and the record is updated by `reconcile`, so a delayed or duplicated event cannot move money state backwards.
- PayPal's webhook guide states that postback verification is not supported for simulator mock events. Verification evidence therefore needs real sandbox events delivered to a registered URL.

## Buyer approval

The buyer approves on PayPal's own pages, either through the approval link or the JavaScript SDK buttons (`https://www.paypal.com/sdk/js?client-id=<sandbox client id>&currency=SEK&components=buttons`, `createOrder` calls the Framvera server and returns the order id, `onApprove` asks the server to capture, `INSTRUMENT_DECLINED` calls `actions.restart()`). The server never approves on the buyer's behalf. The automated sandbox buyer in `src/sandboxBuyer.ts` exists only for end-to-end tests and refuses any host other than PayPal sandbox.

## Capability findings (observed 2026-11-12)

Run with `npx tsx packages/paypal/src/probe.ts --auto`; report in `evidence/paypal-capabilities.json`.

**Card as payment source.** Creating an order with `payment_source.card` (a PayPal sandbox test card) returned HTTP 201 with the order `COMPLETED` and a `COMPLETED` capture in one step, with no buyer redirect and no 3-D Secure challenge. The probe refunded it. Sending raw card numbers from a server requires PCI DSS SAQ D (Orders v2 reference), so a card path in the product would collect the card in PayPal-hosted card fields and pass PayPal's token, never the number.

**Several purchase units in one order.** An order with two purchase units (`probe-obl-a`, `probe-obl-b`) was created, approved by the sandbox buyer and captured: HTTP 201, one capture per unit, each with its own id and status. PayPal returned the units in a different order from the request, so results are matched by `reference_id`, never by position. Both units went to the app's own merchant because no second sandbox merchant was configured.

**Different payees per unit (multi-seller).** Not yet exercised: it needs a second sandbox business account. PayPal's multiseller guide describes up to 10 purchase units with `intent: CAPTURE`, `reference_id` on each unit, and capture that is explicitly not atomic: PayPal "will capture as much as possible", returns HTTP 207 with order status `PARTIALLY_COMPLETED` when only some units capture, and 422 when none do. Platform fees require PayPal to enable the account for marketplaces. Framvera therefore treats each supplier's payment as its own unit of success or failure and surfaces partial results with their compensations, and uses separately approved orders linked to one agreement as the default.

**Webhooks.** The sandbox app had no webhooks registered at probe time.

## Real sandbox lifecycle

`npx tsx packages/paypal/src/smoke.ts --auto` runs create, buyer approval, capture, independent GET, idempotent replay, partial refund and GET, and writes a redacted trace (ids, statuses, amounts, timestamps, debug ids; no tokens, emails or names) to `evidence/paypal-smoke.json`. Without `--auto` it prints the approval link and waits up to ten minutes for a person to approve.

Run on 2026-11-12: order `8UN02957XE984330H` (1 234,50 SEK, two obligation items) approved, capture `8VB78669VP961552M` `COMPLETED`, replay returned the same capture, partial refund `7BM1078719564712J` of 200,00 SEK `COMPLETED`, final capture status `PARTIALLY_REFUNDED`.

## Tests

`npx vitest run packages/paypal`: exact money conversion (property-based), request-id derivation, order body, environment gate, token cache, secret hygiene, and against the fake: idempotent create and capture, timeout before and after success, unreachable reconciliation, rate limit, declined capture, concurrent capture, amount mismatch, refund bounds and currency, refund timeouts, authorize and void, webhook verification, tampering and duplicate delivery.

## Sources

- REST overview and OAuth: https://developer.paypal.com/api/rest/
- Idempotency: https://developer.paypal.com/api/rest/reference/idempotency/
- Responses and errors: https://developer.paypal.com/api/rest/responses/
- Orders v2: https://developer.paypal.com/docs/api/orders/v2/ (schema `https://developer.paypal.com/api/orders/v2/schema.json`, version 2.36)
- Payments v2: https://developer.paypal.com/docs/api/payments/v2/ (schema `https://developer.paypal.com/api/payments/v2/schema.json`)
- Webhooks API: https://developer.paypal.com/api/webhooks/v1/ ; integration guide: https://developer.paypal.com/api/rest/webhooks/rest/
- Currency codes: https://developer.paypal.com/api/rest/reference/currency-codes/
- Multiseller payments: https://developer.paypal.com/docs/multiparty/checkout/multiseller-payments/
- Card testing: https://developer.paypal.com/tools/sandbox/card-testing/
- Standard checkout (JS SDK buttons): https://developer.paypal.com/docs/checkout/standard/integrate/
- Server SDK: https://www.npmjs.com/package/@paypal/paypal-server-sdk (2.5.0)
