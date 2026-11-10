# Server-side cart pricing — Stage 3

`priceCart(items)` prices a cart from SQLite Products only. It does not create an
order, change a product, call a gateway, or modify any HTTP endpoint.

## Interface

```js
const { priceCart } = require("./pricingService");
const priced = await priceCart([{ productId: 1, quantity: 2 }]);
```

Only own data fields `productId` and `quantity` are accepted. Extra fields such as
Price, unitPrice, amount, total, or orderTotal are rejected rather than trusted.
IDs must be positive safe integer Numbers. Quantities must be integer Numbers
from 1 through 999. Carts contain 1–100 distinct lines. Duplicate products are
rejected, not consolidated. These exported limits/policies can be revisited with
the team before endpoint integration; numeric strings are not coerced.

The result contains numeric dollar `orderTotal`, integer `totalCents`, and items:

```js
{
    items: [
        {
            productId: 1,
            productName: "Trail Backpack",
            quantity: 2,
            unitPriceCents: 6499,
            lineTotalCents: 12998
        }
    ],
    totalCents: 12998,
    orderTotal: 129.98
}
```

This is a service result, not a new HTTP response contract. It uses lowercase
service fields; the existing Products SQL columns and public PascalCase fields
are unchanged. Stage 4 now maps productId/productName/unitPriceCents/quantity to
OrderItems.ProductID/ProductName/UnitPriceCents/Quantity through [orderService](ORDERING.md). Snapshots are detached
from later cart/catalog changes; a new pricing call reads current database prices.
A quote alone does not reserve a price: final creation should price and persist
inside one transaction.

For tests or isolated connections:

```js
await priceCart(items, { database: syntheticDatabase });
```

To create an order atomically, Stage 4 can reuse an existing transaction:

```js
await db.withTransaction(async (tx) => {
    return createOrderWithItems({ orderId, customer, items }, { transaction: tx });
});
// Await commit before using the result for a gateway request.
```

Without a supplied transaction, pricing uses the central database's managed
transaction. Never call public database helpers from inside that transaction;
supply `transaction: tx` instead. Database and transaction options are backend
integration arguments, never browser input. `validateCart(items)` is also exported
for callers to capture validated input before waiting on a transaction; it does not query SQLite. Importing the module alone does not
open the lazy default database. Tests always inject a synthetic database.

## Money rules

`moneyService` provides `toCents`, `fromCents`, `addCents`, and `multiplyCents`.
Dollar inputs are nonnegative finite Numbers or plain decimal strings with at
most two decimal places. Strings with whitespace, signs, or exponent notation
are rejected. Number inputs are assessed by their canonical decimal representation;
trailing zeros already discarded by JavaScript cannot be recovered.

There is no rounding of invalid precision: 1.005 and binary arithmetic artifacts
such as 0.1 + 0.2 are rejected as price inputs. Decimal parsing and arithmetic use
BigInt internally, then return safe integer Number cents. No BigInt is returned
in pricing results. Amounts exceeding Number.MAX_SAFE_INTEGER cents, multiplication
or addition overflow, and totals that cannot round-trip as numeric dollars are
rejected. Zero-price products remain supported by the Stage 2 schema; payment
eligibility for a zero-total order is a later integration decision.

Invalid database prices fail with INVALID_PRODUCT_PRICE; invalid input has
specific PricingError codes. Unknown products fail with PRODUCT_NOT_FOUND and
arithmetic/output precision overflow with CART_TOTAL_OVERFLOW. MoneyError has
its own codes for invalid values, precision, and overflow. No HTTP status mapping
is added in this stage, and no fallback prices or totals are used.

## Tests

`npm test` discovers the Stage 1, Stage 2, money, and pricing suites. All SQLite
fixtures are synthetic and temporary. If dependencies exist only in the original
checkout, run from the backend worktree:

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```
