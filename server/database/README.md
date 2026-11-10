# Database access and preserving migrations — Stages 1–2

`database.js` owns connections, readiness, Promise helpers, and managed transactions.
`db.js` re-exports the same lazy default facade for existing imports. `migrations.js`
upgrades supported schemas and `schema.sql` mirrors the current version-2 structure.

## Connection configuration

- `DB_PATH` selects the default file; relative paths resolve from the working directory. The fallback is `server/database/ecommerce.db` in this checkout.
- Importing either database module alone does not open a file. Accessing `ready`, issuing a query, or registering a default error listener initializes the connection. Reading `filename` is side-effect-free.
- Tests use `createDatabase({ filename: temporaryPath })` or `filename: ":memory:"`, never the project database. The factory requires an explicit filename; `busyTimeoutMs` defaults to 5000.
- Every query waits for readiness. Initialization migrates, checks integrity, conditionally seeds products, and restores foreign-key enforcement before returning.

**Back up an existing database consistently before deliberately opening it with this code.**
No real project database has been migrated during this work. Tests use synthetic
fixtures only; do not point test configuration at the original checkout's database.
Do not delete existing data to resolve a migration error.

## Versioned migrations

`PRAGMA user_version` records the committed schema version. Version zero means
unversioned, not empty: existing tables and records are inspected before upgrading.

| Version | Change |
| --- | --- |
| 0 | Legacy or unversioned layout; may already contain historical records |
| 1 | Add `PaymentAuthorizations.FailureReason` if absent and make `AuthorizationToken` nullable if necessary |
| 2 | Add snapshot-based `OrderItems`, without backfilling unknown historical items |

Migration decisions are made after acquiring `BEGIN IMMEDIATE`. Pending migrations,
seed inserts, and version increments commit together. An error rolls all of them
back. Reopening version 2 validates the schema and skips both migration steps.
A fresh database follows the same version sequence, creates all five application
tables, and seeds the original five products only when Products is empty.
New seeds use `/img/p1.png` through `/img/p5.png`, matching storefront PR #4.
Existing product values, including PNG, JPG, or custom image paths and prices, are
not overwritten or normalized during migration or reopening.

The initializer returns a report through `await db.ready`:

```js
// Example for a supported legacy version-zero database:
{
    fromVersion: 0,
    toVersion: 2,
    appliedVersions: [1, 2],
    existingForeignKeyViolations: 0
}
```

### Authorization preservation

When only FailureReason is missing, the migration adds that column without rebuilding
the table. When token nullability must change, it conservatively edits the original
CREATE definition rather than reconstructing it from column metadata. It copies
all supported columns directly in SQL, preserving IDs, historical values, defaults,
other constraints, explicit indexes, owned triggers, table-name casing, and the
AUTOINCREMENT high-water mark. Existing failure reasons remain unchanged; the new
field is NULL for older records with no recorded reason.

Foreign-key enforcement is disabled only on the owned initialization connection,
before the transaction, so rebuilding the authorization table cannot cascade-delete
dependent history. `legacy_alter_table` is temporarily enabled to preserve dependent
views and references, then restored. Foreign-key violations are compared before and
after the migration; introduced or altered violations cause rollback. Pre-existing
violations are retained and counted in the report, not silently repaired or erased.
Foreign keys are enabled again before application queries can execute.

Historical duplicate authorizations and settlements are preserved. No unique
settlement-per-order constraint, status repair, token replacement, or total
recalculation is performed.

Unknown future/negative versions and inconsistent version/schema combinations fail
without applying changes. Authorization schemas with generated/hidden columns,
token primary keys, or CHECK expressions involving the token require a separately
reviewed migration. These are refused rather than weakened or rebuilt lossily.
Existing incompatible OrderItems layouts are likewise refused rather than replaced.

### OrderItems snapshots

| Column | Meaning / constraint |
| --- | --- |
| `OrderItemID` | Unique INTEGER PRIMARY KEY AUTOINCREMENT |
| `OrderID` | Required order reference; deleting an order cascades to its items |
| `ProductID` | Required product reference; deleting a referenced product is restricted |
| `ProductName` | Required, nonblank historical name snapshot |
| `UnitPriceCents` | Required nonnegative integer unit-price snapshot, in USD cents |
| `Quantity` | Required positive integer |

SQLite CHECK constraints enforce actual integer storage for quantity and cents.
Zero-cent products are permitted; zero/fractional quantities and negative/fractional
cent prices are not. Future catalog name/price changes do not update saved snapshots.
Historical orders without known item data remain itemless. Any existing compatible
snapshots are retained. No product/order uniqueness rule is imposed on historical
items; duplicate-cart policy belongs to the later pricing/order service.

## Supported application APIs

```js
const db = require("./db");
await db.ready;
const row = await db.getAsync("SELECT * FROM Products WHERE ProductID = ?", [1]);
const rows = await db.allAsync("SELECT * FROM Products");
const result = await db.runAsync("UPDATE Products SET Name = ? WHERE ProductID = ?", ["Example", 1]);
// result contains lastID and changes.
```

Existing `run`, `get`, and `all` callback calls still support omitted parameters,
named/array/variadic bindings, chaining, and `this.lastID`/`this.changes`. Callbackless
errors emit `error` to a registered listener or log only the error code/name. SQL and
bind values are not logged. This facade supports methods used by current routes;
it does not expose native prepared statements, `serialize`, or a raw connection.

## Managed transactions

```js
await db.withTransaction(async (tx) => {
    await tx.run("UPDATE Products SET Name = ? WHERE ProductID = ?", ["Example", 1]);
    return tx.get("SELECT * FROM Products WHERE ProductID = ?", [1]);
});
```

One queue covers whole transactions and standalone Promise/callback operations.
Transactions use `BEGIN IMMEDIATE`, drain issued queries, and commit or roll back.
Ordinary SQL failures do not poison the queue; a failed rollback blocks later work
because the connection state is uncertain.

Inside the callback, use only `tx.run/get/all`. Public helpers, nested transactions,
and closing from that context reject rather than deadlock. Scoped helpers expire
after the callback. Direct transaction-control SQL is rejected. Never await a
payment or other network service while holding a database transaction.

`closeAsync()` drains accepted work, blocks new work immediately, and is idempotent.
Callback-based `close()` is also supported. The existing server remains unchanged
and does not await readiness before listening; individual database requests still
wait for initialization. Startup orchestration remains integration work.

## Isolated verification

```sh
npm test
```

No new dependencies are required. When using the dependencies already installed in
the original checkout, run from this backend worktree:

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```

The suite retains Stage 1 callback, readiness, queue, transaction, and cleanup tests;
its schema expectations now reflect Stage 2. Migration tests cover fresh and
nonempty legacy databases, exact historical record preservation (5 products,
16 orders, 18 authorizations, 9 settlements), duplicate histories, metadata,
sequences, views/child references, NULL tokens, failure reasons, version validation,
idempotency, concurrent initialization, rollback after each version increment,
foreign keys, snapshot constraints/durability, PNG seed compatibility, and
preservation of all five existing PNG product paths across migration/reopening.

All fixture files are synthetic and live in uniquely created operating-system
temporary directories. Tests close and remove only their own fixtures. No original
project database, application server, payment service, or settlement endpoint is used.

## Next stage

Stage 3 now provides a cent-based pricing service; see [the pricing interface](../services/PRICING.md).
Stage 4 now provides [transactional order creation](../services/ORDERING.md) and uses
it for POST `/api/orders`. Stage 5 now provides [order queries and details](../services/QUERYING.md),
including one highest-ID authorization per order. Payment safety and settlement
eligibility remain later work; the payment endpoint is unchanged.
