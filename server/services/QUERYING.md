# Order queries — Stage 5

These read-only queries use the Stage 1 database facade and Stage 2 schema.
They do not create authorizations, change statuses, calculate settlement eligibility,
reprice existing orders, or modify historical records. The collection contract is
compatible with dashboard PR #5. The new detail contract supports a future warehouse
authorization-details display; no frontend files are changed in Stage 5.

## GET /api/orders

The response remains `{ "success": true, "count": 0, "orders": [] }` for no matches.
Every matching order appears once. Its authorization fields come from the row with
the **highest AuthorizationID for that OrderID**, regardless of timestamp or result.
A later decline is not replaced by an older approval. Missing authorizations yield
NULL authorization fields while retaining the order. `count` counts returned orders.

The collection preserves these exact PascalCase fields:

- OrderID, CustomerName, CustomerEmail, ShippingAddress, City, State, Zip
- OrderDate, OrderTotal, OrderStatus
- AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate
- AuthorizationResult, CardType, CardLast4, FailureReason

The legacy collection still includes AuthorizationToken because PR #5 checks it for
authorization availability. The new detail endpoint never includes it. Removing the
collection token field requires a separately agreed replacement contract for that
presence check. Stage 5 adds no card fields to the collection.

| Query parameter | Existing behavior preserved |
| --- | --- |
| `status` | Exact Orders.OrderStatus match; empty/omitted means all statuses |
| `search` | SQLite LIKE substring search over OrderID, CustomerEmail, CustomerName; empty/omitted means no search |
| `sort=newest` | OrderDate descending; also the default for omitted/unknown sort values |
| `sort=oldest` | OrderDate ascending |
| `sort=amount_desc` | OrderTotal descending |
| `sort=amount_asc` | OrderTotal ascending |

Parameters combine. Search uses bound SQL values and retains SQLite LIKE wildcard
semantics for `%` and `_`. Sorting uses fixed SQL expressions rather than browser
SQL. Equal sort values are ordered by OrderID ascending for deterministic results.
Sorting never uses authorization timestamps. Structured/repeated query values that
Express parses into objects/arrays are rejected with HTTP 400; normal text values,
including empty strings sent by PR #5, are supported.

Example read-only request:

```http
GET /api/orders?status=Authorized&search=alex%40example.test&sort=oldest
```

## GET /api/orders/:id

Supply the exact Order ID as a URL-encoded path segment, for example
`/api/orders/SYNTHETIC-ORDER-001`. A warehouse caller can build the URL with
`encodeURIComponent(orderId)`. IDs are compared as stored; nonblank IDs are not
trimmed or otherwise normalized during lookup. Blank IDs are invalid.
The bare `/api/orders` or `/api/orders/` URL remains the collection endpoint,
not a missing-ID detail request.

HTTP 200 example, using entirely synthetic records:

```json
{
  "success": true,
  "order": {
    "OrderID": "SYNTHETIC-ORDER-001",
    "CustomerName": "Alex Example",
    "CustomerEmail": "alex@example.test",
    "ShippingAddress": "100 Synthetic Way",
    "City": "City",
    "State": "ST",
    "Zip": "00000",
    "OrderDate": "2030-01-01T12:00:00Z",
    "OrderTotal": 129.98,
    "OrderStatus": "Settled",
    "Items": [
      {
        "OrderItemID": 1,
        "OrderID": "SYNTHETIC-ORDER-001",
        "ProductID": 1,
        "ProductName": "Trail Backpack",
        "UnitPriceCents": 6499,
        "Quantity": 2
      }
    ],
    "LatestAuthorization": {
      "AuthorizationID": 2,
      "AuthorizationAmount": 100,
      "TransactionDateTime": "2030-01-01T12:01:00Z",
      "AuthExpirationDate": "2030-01-08",
      "AuthorizationResult": "Success"
    },
    "Settlements": [
      {
        "SettlementID": 1,
        "OrderID": "SYNTHETIC-ORDER-001",
        "FinalShipmentAmount": 75,
        "SettlementDate": "2030-01-02T12:00:00Z",
        "SettlementResult": "Success"
      }
    ]
  }
}
```

The exact top-level fields are `success` and `order`. `order` contains the ten
Orders columns above plus exactly these related-record fields:

| Field | Structure and meaning |
| --- | --- |
| `Items` | Array of OrderItemID, OrderID, ProductID, ProductName, UnitPriceCents, Quantity; ascending OrderItemID |
| `LatestAuthorization` | NULL if absent; otherwise AuthorizationID, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult from the highest-ID authorization |
| `Settlements` | Array of SettlementID, OrderID, FinalShipmentAmount, SettlementDate, SettlementResult; descending SettlementID |

`OrderStatus` is the currently stored order status. `OrderTotal` is the original
stored numeric-dollar total; it is not replaced by the authorization amount or
recomputed from current catalog prices. `Items` contain historical snapshots only;
unit prices are integer cents. Historical orders without snapshots return
`Items: []`, with no inferred/backfilled data. Missing settlements return
`Settlements: []`. All historical settlements, including duplicate or rejected
records, remain visible; this endpoint does not infer a remaining balance.

For the future warehouse display, read the recorded authorization amount from
`order.LatestAuthorization.AuthorizationAmount` rather than `order.OrderTotal`,
and use AuthorizationResult and AuthExpirationDate from that same object.
A stored amount on a declined record does not mean funds were approved; do not
fall back to an older success or treat the display as settlement authorization.
The endpoint reports stored date strings unchanged, including date-only values,
timezones and NULL expiration dates. It does not infer missing expiration dates
or compute expiry/eligibility; the settlement backend must enforce safeguards.

The detail response uses explicit SQL column projections, never SELECT *.
It excludes AuthorizationToken, all card fields (including CardLast4/CardType),
CVV and free-form FailureReason values. Future columns added to these tables do
not automatically become response fields.

## Errors

| Endpoint | HTTP status | JSON response |
| --- | --- | --- |
| Collection | 400 | `{ "success": false, "message": "Order query parameters must be text values." }` |
| Collection | 500 | `{ "success": false, "message": "Failed to retrieve orders." }` |
| Detail | 400 | `{ "success": false, "message": "A nonblank Order ID is required." }` |
| Detail | 404 | `{ "success": false, "message": "Order not found." }` |
| Detail | 500 | `{ "success": false, "message": "Failed to retrieve order details." }` |

An empty collection returns 200, not 404. A detail failure in any related-table
lookup returns 500, never a partially populated success. Internal SQL/error text
is not returned. Express handles malformed URL encodings before the handler.

## Service and transaction interface

```js
const { listOrders, getOrderDetails } = require("./orderQueryService");
const rows = await listOrders({ status: "Authorized", search: "Alex", sort: "newest" }, { database: syntheticDatabase });
const order = await getOrderDetails("SYNTHETIC-ORDER-001", { database: syntheticDatabase });
// A nonexistent order returns null at the service level; the route maps it to 404.
```

Both helpers default to the lazy central database facade, without opening a
connection merely on import. Tests always inject temporary databases. Collection
queries use one bound SQL statement. Details read the order and related records
in one managed transaction for a consistent snapshot. The current central helper
uses BEGIN IMMEDIATE, so these short read transactions can briefly serialize with
writers; no network work occurs inside them. No schema or indexes are changed.

## Verification and remaining integration

Tests use synthetic temporary SQLite fixtures and mocked API handlers. They cover
latest-ID selection independent of timestamp/result, null authorizations, one row
per order, all filters/sort modes, safe parameter binding, exact legacy response
fields, historical snapshots, duplicate settlements, missing orders/IDs, exact
expiration values, explicit sensitive-field exclusion, and database failures.
An in-process real Express router check also verifies collection routing and
URL-decoded detail IDs without opening a listening socket.
All Stage 1–4 behavioral checks remain, with the old GET source-equality assertion
replaced by an exact collection-field contract check.

From the backend recovery worktree, using already-installed dependencies:

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```

No real database, live server, gateway, or payment/settlement request is used.
Stage 6 now provides [atomic settlement safeguards](SETTLEMENTS.md); order queries
continue to report stored values without making eligibility decisions. Warehouse
detail display remains pending. The integrated [payment workflow](PAYMENTS.md)
adds Payment Review to the dashboard filter; live gateway behavior is unverified.
