# Transactional order creation — Stage 4

`createOrderWithItems()` validates an order request, prices its cart from SQLite,
and saves Orders plus every OrderItems snapshot in one managed transaction.
It creates a Pending order only: it does not contact a gateway, create an
authorization, settle an order, or accept browser prices/totals.

## Service interface

```js
const { createOrderWithItems } = require("./orderService");
const created = await createOrderWithItems({
    orderId: "SYNTHETIC-ORDER-001",
    customer: {
        firstName: "Alex",
        lastName: "Example",
        email: "alex@example.test",
        address: "100 Synthetic Way",
        city: "City",
        state: "ST",
        zip: "00000"
    },
    items: [{ productId: 1, quantity: 2 }]
});
```

This is an illustrative request, not a setup step; executing it writes records.
All example data is synthetic. Exactly the top-level fields `orderId`, `customer`,
and `items` are supported. The Order ID must be a nonblank string and is trimmed;
there is no automatic ID generation. Existing IDs are never updated or reused.

Customer fields are limited to the seven fields shown. `firstName`, `email`, and
`address` are required nonblank strings; email must match a basic email shape.
Optional `lastName`, `city`, `state`, and `zip` default to empty strings. Supplied
fields must be strings, and text is trimmed. Extra fields, including card details,
are rejected rather than persisted. String data is bound to SQL parameters.

Items follow Stage 3: only positive integer product IDs and integer quantities,
1–100 distinct lines, quantity 1–999, no duplicates or client price/snapshot fields.
The service snapshots validated inputs before awaiting a queued transaction.

The returned service result includes `orderId`, server-generated UTC `orderDate`,
`orderStatus: "Pending"`, numeric-dollar `orderTotal`, integer `totalCents`, and
priced `items` with `productId`, `productName`, `quantity`, `unitPriceCents`, and
`lineTotalCents`. Item snapshots map directly to the Stage 2 schema.

## Transaction ownership and payment integration

By default the helper owns one database transaction and returns after commit:

```js
await createOrderWithItems(input, { database: syntheticDatabase });
```

For a caller that already owns a managed transaction:

```js
const created = await db.withTransaction(async (tx) => {
    return createOrderWithItems(input, { transaction: tx });
});
// The outer transaction has now committed.
```

Use either `database` or `transaction`, never both. Transaction scopes must provide
Promise-based `get`, `all`, and `run`. The helper calls `priceCart()` with that
same scope, so there is no nested transaction or pricing/write gap. A duplicate
ID is checked while holding the write transaction; the Orders primary key remains
an additional database guarantee. The helper never upserts or changes an old status.

When supplying a transaction, its owner must propagate errors and roll back rather
than swallowing a failure and committing. Results from an inner helper are provisional
until the outer transaction commits. Standalone calls automatically roll back on errors,
including failed or ignored order/item inserts.

Quentin's future payment handler should pass only `{ orderId, customer, items }`
to this helper, excluding payment/card fields. Use the returned `orderTotal` after
commit as the gateway amount. Never hold this transaction open while awaiting the
gateway. Do not precreate an order through POST `/api/orders` and then attempt to
create it again through the future payment helper: that is a duplicate, not a retry.
Every new payment attempt must use its own Order ID.

## POST /api/orders

The endpoint now accepts the service input shown above. Legacy amount-only bodies
and bodies containing `amount`, `orderTotal`, or other top-level extras are rejected.
This is an intentional request-contract change; the response fields remain compatible.

HTTP 201, assuming product 1 costs 64.99:

```json
{
  "success": true,
  "message": "Order created successfully.",
  "orderId": "SYNTHETIC-ORDER-001",
  "orderTotal": 129.98,
  "orderStatus": "Pending"
}
```

Errors retain `{ "success": false, "message": "..." }`:

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid order/customer/cart, client-supplied price fields, duplicate cart products, or cart overflow |
| 404 | A requested product does not exist |
| 409 | The Order ID already exists; nothing is overwritten |
| 500 | Invalid stored product data, initialization/database failure, or incomplete persistence |

`OrderError` carries a service `code` and `statusCode`; pricing errors retain their
Stage 3 codes. Unrelated SQLite constraint failures are not mislabeled as duplicate
Order IDs. Unexpected database errors return a generic message without SQL details.
Zero-price carts can produce a zero-total Pending order; gateway eligibility for
such an order remains a later payment decision.

Stage 5 now provides [order queries and details](QUERYING.md). GET `/api/orders`
preserves its envelope, PascalCase fields and query parameters while selecting only
the highest-ID authorization per order. GET `/api/orders/:id` returns safe related
records. The existing POST `/api/payments` handler is also
unchanged and still has its previously documented legacy amount/upsert/fallback
problems. Stage 4 does not secure that separate payment endpoint.

## Verification

`npm test` includes synthetic service tests and mocked route-handler tests with real
temporary SQLite databases. Coverage includes successful/multiple-product orders,
exact cents, validation, tampering, duplicate/concurrent requests on one or two
connections, insert failures/ignored writes, rollback/recovery, caller-owned scopes,
queued-input snapshots, historical price/name preservation, 409 mapping, and existing
GET behavior. No application server, payment request, or project database is used.

The original Stage 1–3 tests remain in the suite. No new dependency is required:

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```

Stage 5 order-detail/latest-authorization queries are implemented; see [the query
contract](QUERYING.md). Payment integration and settlement safeguards remain pending.
Stage 6 has not started.
