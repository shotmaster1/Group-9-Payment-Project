# Integrated checkout and payments

This implementation lives on bassel-system-integration. The reviewed gateway client
in paymentService.js is adapted from Quentin's Payment API2 commit 33ee567: it keeps
OAuth caching, concurrent token-request sharing, one refresh after an explicitly
denied authorization 401, structured outcomes, and a timeout covering response bodies.
The root Payment API and Payment API2 files remain archival inputs, not runtime imports.
No fake tokens, fallback approvals, or invented expiration dates exist in the active flow.

## Authoritative quote contract

POST `/api/payments/quote` accepts only:

```json
{ "items": [{ "productId": 1, "quantity": 2 }] }
```

It prices SQLite Products using priceCart and returns success, items, totalCents,
orderTotal, quoteToken and expiresAt. Items include productId, productName, quantity,
unitPriceCents and lineTotalCents. All examples here are synthetic and not captured
provider responses. For a product priced at 64.99, the total above is 129.98.

Quotes create no orders or authorizations. A five-minute HMAC-signed token binds the
server-calculated total and item/name/price/quantity snapshots. The signing key exists
only in this process's memory. Restarting the server invalidates outstanding quotes;
checkout refreshes them and requires another explicit Pay click. The token contains
no customer, card, merchant, or payment-authorization credentials.

At payment creation, the server reprices inside the order transaction and checks
the signature, expiry and current price fingerprint. Changed products, quantities,
prices or quote keys cause HTTP 409 QUOTE_CHANGED with outcome rejected; provisional
order/items roll back, and the gateway is never contacted. Quotes do not reserve prices.
Checkout displays the refreshed amount before asking the customer to confirm again.

Cart items use numeric product IDs and integer quantities, 1–100 distinct lines and
quantity 1–999. Duplicate or unknown products, browser price fields, and invalid stored
prices fail closed. Pricing is the sum of product prices and quantities; no tax,
shipping surcharge, inventory reservation, or refund feature is added.

## Payment request and response

POST `/api/payments` accepts the following shape. Placeholder card fields are
intentionally unusable; never substitute real card data in documentation or tests.

```json
{
  "orderId": "SYNTHETIC-ORDER-001",
  "customer": {
    "firstName": "Alex",
    "lastName": "Example",
    "email": "alex@example.test",
    "address": "100 Synthetic Way",
    "city": "City",
    "state": "ST",
    "zip": "00000"
  },
  "items": [{ "productId": 1, "quantity": 2 }],
  "quoteToken": "<SERVER_GENERATED_QUOTE_TOKEN>",
  "cardNumber": "<SANDBOX_TEST_CARD>",
  "cardMonth": 12,
  "cardYear": 2035,
  "ccv": "<SANDBOX_TEST_SECURITY_CODE>",
  "cardType": "visa"
}
```

Browser amount/total fields are rejected. Customer fields and card number, card
expiration, CVV and derived card type are validated server-side. Month is numeric
1–12, year is four digits, and cardNumber/ccv are digit strings. These preserve the
existing outgoing provider field conventions; live acceptance remains unverified.
The backend never generates a replacement Order ID or overwrites an existing order.

Confirmed HTTP 200, assuming the exact quoted total was approved and persisted:

```json
{
  "success": true,
  "outcome": "approved",
  "code": "PAYMENT_AUTHORIZED",
  "status": "Authorized",
  "message": "Payment authorized successfully.",
  "orderId": "SYNTHETIC-ORDER-001",
  "orderTotal": 129.98,
  "authorizedAmount": 129.98,
  "expirationDate": "2030-01-08T12:00:00Z"
}
```

The public payment response never includes an authorization token, full card number,
or CVV. Financial comparisons use integer cents through moneyService. Only an exact
match between the actual approved amount and original server-priced total is
confirmed success, as explicitly approved by the project owner. Partial or oversized
approvals require review, retain the cart, and cannot be settled.

A mismatch returns HTTP 502 with outcome uncertain, code AUTHORIZED_AMOUNT_MISMATCH
and OrderStatus Payment Review. Checkout displays: "The gateway authorization amount
does not match the order total. Payment requires review. Do not submit this payment
again until its status is confirmed." The actual usable approval stays in the
history, while the order is never marked Authorized. Tests cover lower/higher
amounts including one-cent differences, cart retention, blocked settlement, and
no additional payment request after clicks, Enter, or reload.

Errors contain success false, outcome, code and message; orderId, status and totals
are present when available. Clients must inspect outcome, not infer retry safety
from HTTP status alone:

| HTTP | Typical meaning |
| --- | --- |
| 400 / 422 | Invalid input or definite provider rejection |
| 402 | Confirmed decline, including HTTP 200 with provider Success false |
| 409, QUOTE_CHANGED | No gateway attempt; refresh and explicitly reconfirm the quote |
| 409, DUPLICATE_ORDER_ID | Existing attempt; no new gateway call; verify before another attempt |
| 502 | Unusable/contradictory response, unsupported approval, or provider authentication/server error |
| 503 | Missing configuration or service/network unavailability |
| 504 | OAuth or authorization request/body timeout |
| 500 | Database/order/persistence error; outcome distinguishes no-gateway rejection from post-gateway uncertainty |

outcome rejected/declined is a definite unsuccessful attempt. outcome uncertain
means keep the cart, lock payment, and verify the Order ID. Missing credentials
fail before order creation; an OAuth failure before any authorization request is a
safe rejection. Errors do not expose raw provider reasons, SQLite errors or secrets.

## Transaction and persistence sequence

1. Validate and snapshot the request. Check gateway configuration without network I/O.
2. In one managed transaction, call createOrderWithItems with its supplied tx scope,
   then verify the quote against the saved snapshots. Duplicate IDs return 409 before
   any gateway call. Failure rolls back all provisional order/item writes.
3. Commit Pending order/items, then call the gateway outside any database transaction.
4. In a second transaction, require the order still to be Pending with no existing
   authorization; revalidate the result/expiration and save the result plus status
   update atomically. Both writes must affect exactly one row.
5. Return success only after that transaction commits.

The approval must explicitly identify the same Order ID and include a usable token,
positive precise amount, and unexpired explicit-timezone expiration. Tokens with
whitespace/control characters or excessive length are not accepted or stored.
No fallback values replace missing fields.

| Result | Persisted representation |
| --- | --- |
| Valid exact approval | Actual token, numeric approved amount, exact expiration; AuthorizationResult Success; OrderStatus Authorized |
| Definite decline/rejection | AuthorizationResult Failed; amount 0 means no confirmed funds; NULL token/expiration; controlled failure code; OrderStatus Payment Failed |
| Matching-order approval with valid amount but invalid metadata/different amount | Preserve the actual amount and usable token/raw expiration when available; AuthorizationResult Success with a review code; OrderStatus Payment Review |
| Unknown transport/result, wrong Order ID, or unusable amount | No invented authorization row/amount; OrderStatus Payment Review |
| Post-approval persistence failure | Never return success; confirmed rollback retains the Pending order/items and no partial authorization; outcome uncertain |

The original OrderTotal and OrderItems snapshots never change to match an approval.
Only card type and last four digits are stored. FailureReason is a controlled code,
not a raw gateway body that might contain sensitive information. For outcomes with
no usable authorization row, Payment Review is the durable marker; there is no
separate provider-reconciliation ledger or automated resolution UI in this scope.

A database rollback cannot undo an external authorization. If persistence fails,
return uncertainty and never resend automatically. A rollback failure invokes the
existing connection quarantine; do not silently reopen or replay the operation.
Orders needing review remain blocked by the existing settlement status check.

## Expiration policy remains strict

Payments and settlements share [the unchanged Stage 6 parser](SETTLEMENTS.md).
Date-only, timezone-free, missing, impossible or expired values never become a
usable payment approval. Explicit-zone timestamps must satisfy now < expiration;
equality is expired. No timezone or end-of-day meaning is invented.

A provider may already have authorized funds even when its expiration is unusable.
Such an order is Payment Review, not a confirmed checkout success or an invented
decline. Date-only values remain blocked until the team confirms the provider
contract and explicitly approves a policy change. No refunds/releases/voids/captures
are performed by this implementation.

## Checkout behavior

The existing pages, CSS, input layout, validation formatting and cart controls are
preserved. The storefront refreshes saved product metadata from the catalog and
navigates to checkout without a browser amount. Checkout fetches its quote from the
server, renders safe text nodes, and ignores URL amount/Order ID parameters.

Every deliberate new payment attempt gets a cryptographically generated Order ID.
An in-flight guard covers clicks and Enter submissions. Before sending, checkout
stores only Order ID and state in group9PaymentAttempt (no card/CVV/token). Unknown
outcomes lock the page and remain locked after reload. No automatic payment retry
or automatic outcome resolution occurs. Storage/secure-ID failure before sending
prevents authorization.

A successful response must be HTTP-successful, structurally complete, match the
attempt ID and quoted totals, and report Authorized before the purchased quantities
are removed. Card/CVV inputs are cleared then. Newly added cart quantities are
preserved. Definite rejection retains the cart and allows correction with a fresh
ID; stale quotes refresh without automatically paying. Cart-cleanup failure never
changes confirmed approval into a declined payment or enables repayment.

The dashboard includes Payment Review as a filter; its existing safe rendering,
masking, filtering and warehouse navigation remain. The warehouse contract remains
unchanged and still rejects review orders. Its unusedAuthorizationAmount field is
arithmetic reporting, not proof that funds were released.

## Verification and real-world limits

The suite retains the original 168 cases and adds gateway, quote, payment transaction,
checkout and full storefront/dashboard/warehouse journey checks using temporary
SQLite databases and mocked fetch/DOM. The historical date-only regression pins the
old handler at integration checkpoint 00d8161; current payment semantics have their
own tests. Route-composition assertions now verify the mounted reviewed router.

Run with already-installed sibling dependencies if this worktree has no node_modules:

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```

No real database, live gateway request, credentials, or browser renderer is used by
these tests. Live authentication, provider response schemas/card-year conventions,
normal expiration format, and real browser layout remain unverified. Confirm those
with the gateway/team before authorizing sandbox calls. Existing databases must be
backed up consistently and their preserving migration approved before deployment.
