# Group 9 — Manhattan Associates Payment Capstone

Kennesaw State University senior capstone project for Manhattan Associates. This
branch combines the storefront, customer checkout, order dashboard, warehouse UI,
and the six-stage SQLite/backend recovery implementation.

## Current implementation

The code on **bassel-system-integration** now connects server-priced checkout to one
reviewed payment client adapted from Quentin's Payment API2 (33ee567). Orders/items
and authorization/status updates use managed transactions. The strict expiration
policy and warehouse safeguards remain in force. This is a capstone prototype:
synthetic automated verification does not establish live gateway readiness.

The original storefront/dashboard/recovery branches and PR #4/#5 are separate source
histories. Combining or editing this worktree does not merge their GitHub PRs.

## Technology and setup

Node.js/CommonJS, Express 5, SQLite/sqlite3, HTML/CSS/browser JavaScript, dotenv,
cors, and nodemon. Package versions and commands are in [package.json](package.json)
and [package-lock.json](package-lock.json). Use a Node runtime supported by the
locked native dependencies (Node 20.17+ within 20.x, or 22.9+).

Obtain this implementation in an appropriate checkout. If dependencies need to be
installed, the normal project setup command is npm ci; do not install or alter
shared dependencies during a restricted integration audit. This worktree can use
already-installed sibling dependencies as shown in the test command below.

Environment configuration belongs in a private root .env file or the process
environment. These are placeholders, never working credentials:

```dotenv
MA_MERCHANT_ID=YOUR_SANDBOX_MERCHANT_ID
MA_SECRET_KEY=YOUR_SANDBOX_SECRET_KEY
PORT=3000
DB_PATH=/absolute/path/to/an/approved-demo.sqlite
```

| Variable | Meaning |
| --- | --- |
| MA_MERCHANT_ID / MA_SECRET_KEY | Required to attempt gateway authorization; missing values fail closed |
| PORT | Optional; defaults to 3000 |
| DB_PATH | Selects the database; use an explicit approved synthetic database for manual integration testing |

No .env file, credentials, or real database is supplied by these changes. Do not
point manual tests at the original ecommerce.db. Ignore/exclude secrets, node_modules
and database files from commits.

| Command | Behavior |
| --- | --- |
| npm start | Runs node server/server.js |
| npm run dev | Runs nodemon server/server.js |
| npm test | Runs node --test test/*.test.js with synthetic temporary databases |

Run from the project root so dotenv resolves configuration. The same server serves
frontend and API on http://localhost:3000 (or PORT); no frontend build is required.
Starting the application is a deliberate action, not a verification step performed
by this implementation. Without local dependencies, an approved manual start can
use NODE_PATH=../Group-9-Payment-Project/node_modules with the same npm command.

## SQLite and preserving initialization

[db.js](server/database/db.js) re-exports the lazy central
[database.js](server/database/database.js) module. Without DB_PATH, its fallback is
server/database/ecommerce.db in this checkout. Import alone does not open it; first
use initializes/migrates the configured database before queries proceed.

**Back up an existing database consistently before deliberately opening it with
this code.** Do not delete it to resolve a mismatch. PRAGMA user_version migrations
preserve supported historical records, primary keys, relationships, duplicate
histories and product image paths. Version zero does not mean empty.

The version-2 schema contains Products, Orders, PaymentAuthorizations, Settlements,
and historical-snapshot OrderItems. AuthorizationToken is nullable and FailureReason
exists. Empty Products receive five PNG-based seeds; existing product prices and
PNG/JPG/custom image paths are not overwritten. No historical items are invented.

Read [the database guide](server/database/README.md) before planning a migration.
No real database has been opened or migrated by this integration work.

## Pages and navigation

| Page | Behavior |
| --- | --- |
| / or /index.html | Catalog from SQLite, add/remove/quantity controls and a saved cart |
| /checkout.html | Server-authoritative quote, customer/card validation and payment submission |
| /orders.html | Safe dashboard, ID/email/name search, filters, sorting, masked cards and authorization expiry |
| /warehouse.html?orderId=SYNTHETIC-001 | Prefilled settlement form with loading/error handling and submission locks |

Use pages through Express rather than opening local HTML files. The storefront
checkout button no longer sends a browser amount in the URL. Checkout maps saved
ProductID values to productId/quantity lines; stored browser prices/names do not
control authorization. Server quote changes require another explicit confirmation.

Checkout creates a fresh ID for each deliberate attempt. A pending/unknown attempt
is kept in sessionStorage to block accidental repayment after reload. Confirmed
success removes purchased cart quantities and clears card/CVV inputs; declines keep
the cart. Unknown results never automatically retry.

The dashboard preserves its PascalCase API contract and 250 ms search debounce,
request cancellation/counter, textContent rendering, masking and order-date sorting.
Payment Review is available as a status filter. Only Authorized orders offer Settle
Order; the backend independently checks all settlement eligibility.

Warehouse success remains message/orderId/finalAmount/authorizedAmount, now also
including unusedAuthorizationAmount. It requires a positive cent amount, an
Authorized order, a successful latest authorization and valid unexpired timezone
information, with no existing settlement row. Validation/insertion/status update
are atomic. Browser and backend protection prevent duplicate submissions.

## Implemented API

| Method | Endpoint | Contract |
| --- | --- | --- |
| GET | /api/test | Health message |
| GET | /api/products | success plus products with ProductID, Name, Description, Price, ImageURL |
| GET | /api/orders | success/count/orders; one row per order with highest-ID authorization |
| GET | /api/orders/:id | success/order including Items, LatestAuthorization and Settlements |
| POST | /api/orders | orderId/customer/items; Pending order and snapshots, no gateway call |
| POST | /api/payments/quote | items only; authoritative prices and a five-minute signed quote |
| POST | /api/payments | orderId/customer/items/quoteToken/card fields; priced order, gateway and atomic result persistence |
| POST | /api/settlements | orderId/finalAmount; local settlement and unused amount |

JSON POST bodies use Content-Type: application/json. GET /api/products/:id is not
implemented. Checkout must not first create its order through POST /api/orders:
the payment endpoint owns creation and rejects existing IDs with HTTP 409.

GET /api/orders supports exact status, LIKE substring search across Order ID/email/
name, and newest/oldest/amount_asc/amount_desc sorting. Names remain PascalCase.
GET details return saved item snapshots (or an empty array for historical orders),
original total, actual latest authorization amount/expiry and all settlement history.
Detail responses exclude authorization tokens and card fields.

Full field/error contracts and synthetic examples are in:

- [Pricing](server/services/PRICING.md)
- [Order creation](server/services/ORDERING.md)
- [Order queries/details](server/services/QUERYING.md)
- [Payments/quotes/checkout](server/services/PAYMENTS.md)
- [Settlement policy and responses](server/services/SETTLEMENTS.md)

### Synthetic payment examples

A quote request creates no order:

```json
{ "items": [{ "productId": 1, "quantity": 2 }] }
```

For product 1 priced at 64.99, the response contains numeric orderTotal 129.98,
totalCents 12998, item snapshots, quoteToken and expiresAt. Supply the returned token
with the payment request described in the payment guide; never supply a browser
amount. Examples are illustrations, not setup steps or usable payment requests.

Confirmed HTTP 200 response:

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

No raw token, full card number or CVV is returned. HTTP status alone does not define
retry safety: outcome declined/rejected permits correction, while uncertain locks
payment pending verification. Duplicate IDs (409) never cause a second gateway call.
QUOTE_CHANGED (409/rejected) refreshes pricing without automatically paying again.

A local under-settlement response for that authorization and an 80 shipment is:

```json
{
  "message": "Successful settlement request received",
  "orderId": "SYNTHETIC-ORDER-001",
  "finalAmount": 80,
  "authorizedAmount": 129.98,
  "unusedAuthorizationAmount": 49.98
}
```

Unused authorization is arithmetic reporting only. No refund, release, void or
external capture is implemented or implied.

## Known limitations and remaining verification

- The gateway's usual expiration format, actual credential acceptance, card-year
  convention and live provider behavior remain unverified. No live payment request
  was made. Date-only/missing/timezone-free expirations remain rejected; never append
  a timezone or invent a cutoff without an explicitly approved provider policy.
- Exact-match approvals alone complete checkout. Different approved amounts or
  unusable metadata retain actual usable data, set Payment Review and keep the cart.
  Unknown transport results and post-approval database failures require manual
  provider/order verification. There is no automatic reconciliation/retry or refund.
- Database transactions cannot undo an external authorization. A post-approval
  persistence failure never returns success. A failed rollback quarantines its
  connection and must be investigated before further operations.
- Existing databases need a consistent backup and approved preserving migration
  before deployment. The real ecommerce.db has not been used in tests.
- APIs currently have no authentication middleware and CORS remains unrestricted.
  The legacy collection still includes AuthorizationToken for the dashboard's
  presence check; detail/payment responses exclude it. A safe replacement collection
  contract is separate work.
- Warehouse detail/unused-amount display is not yet added. Native browser visual
  layout and live gateway end-to-end behavior have not been certified.

## Automated verification

The committed recovery/integration suite is extended in this worktree with mocked
gateway, quote, checkout, price-change, duplicate-request, persistence-failure and
full storefront-to-settlement checks. Fixtures use only temporary synthetic SQLite
files. Browser scripts execute against mocked DOM/fetch and actual service/router
code; this is not a live browser or real gateway transaction.

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```

No new dependencies are required. Original branches/PRs and real databases are not
modified by these tests. The current implementation changes remain subject to
review before committing or pushing.
