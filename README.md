# Group 9 — Manhattan Associates Payment Capstone

Kennesaw State University senior capstone project for Manhattan Associates. The project demonstrates customer checkout, payment authorization, order management, and warehouse settlement using a Node.js application and SQLite.

## Current implementation

This README describes the code on **`bassel-dashboard-security`**, including safe dashboard rendering, authorization expiration display, server-side order search/filtering/sorting, and warehouse submission feedback and duplicate-submit prevention. These branch changes may not be available in a fresh checkout of `main` until integrated.

The product catalog and shopping cart storefront exist on the separate **`bassel-storefront`** branch and are awaiting integration. The home page on this branch is a checkout demo launcher, not the catalog. The application remains a capstone prototype; the pending pricing, payment, and settlement work is listed below.

## Technology stack

| Component | Technology |
| --- | --- |
| Runtime | Node.js, CommonJS modules |
| HTTP server | Express 5 |
| Database | SQLite through `sqlite3` |
| Frontend | HTML, CSS, and browser JavaScript |
| Configuration | `dotenv` |
| Development restart | `nodemon` |
| Cross-origin middleware | `cors` |

Dependency versions and scripts are defined in [package.json](package.json) and pinned by [package-lock.json](package-lock.json).

## Installation and setup

### Prerequisites

- Node.js **20.x (at least 20.17.0), or 22.9.0 or newer**, and npm. Locked native-build dependencies declare `^20.17.0 || >=22.9.0`; the project does not declare a separate Node engine range.
- Git to obtain the repository.
- Manhattan Associates sandbox credentials for gateway authentication. The merchant credentials are not included in the repository.

### Install dependencies

If needed, clone the repository:

```sh
git clone https://github.com/shotmaster1/Group-9-Payment-Project.git
cd Group-9-Payment-Project
```

Use a checkout containing the implementation described above. Cloning alone does not select local, unmerged branch work. If the repository is already available, start from its root directory.

```sh
npm ci
```

### Environment variables

Create a `.env` file in the repository root. The following values are placeholders, not working credentials:

```dotenv
MA_MERCHANT_ID=YOUR_SANDBOX_MERCHANT_ID
MA_SECRET_KEY=YOUR_SANDBOX_SECRET_KEY
PORT=3000
```

| Variable | Purpose | Requirement |
| --- | --- | --- |
| `MA_MERCHANT_ID` | Merchant identifier sent to the gateway OAuth endpoint | Required for real sandbox authentication |
| `MA_SECRET_KEY` | Merchant secret sent to the gateway OAuth endpoint | Required for real sandbox authentication |
| `PORT` | Express listening port | Optional; defaults to `3000` |

Start commands from the repository root so `dotenv` finds `.env`. This branch has no `.env.example`. `.gitignore` excludes `.env`, `node_modules/`, and `*.db`; never add credentials or real card data to documentation, commits, or screenshots. The server does not validate credential presence at startup, so a running server does not establish working gateway authentication.

### Start the application

For normal execution:

```sh
npm start
```

For development with automatic restarts, use this instead:

```sh
npm run dev
```

| Command | Script executed |
| --- | --- |
| `npm start` | `node server/server.js` |
| `npm run dev` | `nodemon server/server.js` |

Open `http://localhost:3000/`, replacing the port if configured differently. The same Express process serves both the frontend and API; there is no separate frontend build or development server. Stop it with `Ctrl+C`.

A read-only HTTP check is available once the server is running:

```sh
curl http://localhost:3000/api/test
```

## SQLite database

The active database module is [server/database/db.js](server/database/db.js). It opens or creates:

```text
server/database/ecommerce.db
```

The path is resolved relative to the database module. Startup enables foreign keys and creates missing tables:

| Table | Current purpose |
| --- | --- |
| `Products` | Product names, descriptions, prices, and image URLs |
| `Orders` | Customer/shipping details, order dates, totals, and status |
| `PaymentAuthorizations` | Authorization token, amount, result, expiration, card type/last four, and failure reason |
| `Settlements` | Local settlement records and final shipment amounts |

When `Products` is empty, startup seeds five products: Trail Backpack, Insulated Bottle, Trail Cap, Hiking Socks, and Camp Lantern. Existing products are not updated by this seed routine. The current seeds reference `.jpg` image paths; the separate storefront work includes PNG assets that still need reconciliation.

**Back up an existing database before any schema or integration changes.** Coordinate a consistent backup while the application is stopped or use SQLite-aware backup tooling. Do not delete an existing database to resolve a schema mismatch.

Initialization uses `CREATE TABLE IF NOT EXISTS`, which does **not** migrate existing tables. Older databases may lack `PaymentAuthorizations.FailureReason` and still require a non-null `AuthorizationToken`. Current queries and failed-payment inserts expect the updated schema, so a migration preserving existing records may be required before dashboard loading or failure recording works.

`server/database/database.js` and `server/database/schema.sql` are empty placeholders on this branch. There is no migration command or `OrderItems` table yet.

## Frontend pages and navigation

Open pages through the running Express server, rather than directly as local files.

| Path | Current behavior |
| --- | --- |
| `/` or `/index.html` | Demo home page linking to checkout with an example amount |
| `/checkout.html?amount=89.98` | Customer/card validation and authorization submission using the legacy amount-based flow |
| `/orders.html` | Order dashboard with ID/email/name search, status filtering, newest/oldest sorting, masked cards, and authorization expiration |
| `/warehouse.html?orderId=DOC-ORDER-001` | Settlement form with the Order ID prefilled from the URL |

The home page currently links only to checkout; open the dashboard directly at `/orders.html`. An Authorized row's **Settle Order** button opens the warehouse page with its Order ID encoded in the URL. The warehouse page can also be opened directly and completed manually.

### Dashboard behavior

- Searches are debounced by 250 ms. Status and sort changes request results immediately.
- Requests send `status`, `search`, and `sort` to the backend. The browser preserves the returned order rather than sorting locally.
- Cancellation and a request counter prevent older responses from overwriting newer results.
- Loading, empty-result, and error messages appear in the table. Order values are rendered with `textContent` and buttons use event listeners.
- Cards display only type and valid last-four digits. Raw authorization tokens are concealed in the table, although the current API still returns them.
- Authorization expiration uses `AuthExpirationDate`: valid date-only values retain their calendar date; timestamps with an explicit offset display in UTC; missing or invalid values display `N/A`.

### Warehouse behavior

The form requires a nonblank Order ID and a finite amount greater than zero with no more than two decimal places. It sends only the captured Order ID and final amount to the settlement endpoint.

While submitting, inputs and the submit button are disabled and the page displays **Submitting settlement...**. An in-flight flag also prevents repeated Enter-key submissions. HTTP 400/404 rejections allow correction and retry. Confirmed success keeps the form locked for that page.

Network errors, server errors, and unrecognized success responses can leave the settlement outcome uncertain. The page stays locked and instructs the user to **verify the order status before attempting another settlement**. It does not retry automatically. This browser protection does not prevent duplicate requests across tabs or reloads.

## Implemented API

JSON POST bodies use `Content-Type: application/json`. The base URL is `http://localhost:3000` unless the port is changed.

| Method | Endpoint | Implementation |
| --- | --- | --- |
| GET | `/api/test` | Health message in `server/server.js` |
| GET | `/api/orders` | Order list/search in `server/routes/orders.js` |
| POST | `/api/orders` | Pending order creation in `server/routes/orders.js` |
| POST | `/api/payments` | Authorization handler in `server/server.js` |
| POST | `/api/settlements` | Local settlement recording in `server/routes/settlements.js` |

`GET /api/products`, `GET /api/products/:id`, and `GET /api/orders/:id` are **not implemented on this branch**. `server/routes/payments.js` and `server/services/paymentService.js` are empty placeholders; the active gateway module is the root [Payment API](Payment%20API) file.

### Example conventions

All identities, IDs, amounts, dates, and responses below are synthetic illustrations of implemented contracts, not captured transactions. They are not guaranteed to match local database contents. POST examples are documentation, not setup steps: executing them would create or change records. Payment placeholders are deliberately not usable card/security-code values, and token values are redacted.

### GET `/api/test`

HTTP 200:

```json
{
  "message": "Group 9 server is online."
}
```

### GET `/api/orders`

| Query parameter | Behavior |
| --- | --- |
| `status` | Exact order-status match; empty or omitted means all statuses. UI options are `Pending`, `Authorized`, `Payment Failed`, and `Settled`. |
| `search` | SQL `LIKE` search over Order ID, customer email, and customer name. `%` and `_` are wildcards. |
| `sort` | `oldest`: order date ascending; `amount_asc` or `amount_desc`: total ascending/descending; `newest`, omitted, or other values: order date descending. |

The dashboard currently exposes newest/oldest sorting. Query values are bound as SQL parameters; sort choices select fixed SQL clauses.

Example request:

```sh
curl 'http://localhost:3000/api/orders?status=Pending&search=DOC-ORDER-001&sort=newest'
```

Illustrative HTTP 200 response for an order without an authorization:

```json
{
  "success": true,
  "count": 1,
  "orders": [
    {
      "OrderID": "DOC-ORDER-001",
      "CustomerName": "Alex Example",
      "CustomerEmail": "alex@example.com",
      "ShippingAddress": "100 Example Way",
      "City": "Kennesaw",
      "State": "GA",
      "Zip": "30144",
      "OrderDate": "2026-11-03T12:00:00.000Z",
      "OrderTotal": 10,
      "OrderStatus": "Pending",
      "AuthorizationToken": null,
      "AuthorizationAmount": null,
      "TransactionDateTime": null,
      "AuthExpirationDate": null,
      "AuthorizationResult": null,
      "CardType": null,
      "CardLast4": null,
      "FailureReason": null
    }
  ]
}
```

No matches returns `{"success":true,"count":0,"orders":[]}`. Database errors return HTTP 500 with `success: false` and `message`.

Field names preserve SQL capitalization. `AuthExpirationDate` is the authorization expiration, not the card expiration. The query currently joins all authorizations: an order can appear more than once, and `count` counts returned rows rather than unique orders.

### POST `/api/orders`

Creates a Pending order without performing payment authorization. The route checks for `customer.firstName`, `customer.email`, and `customer.address`. `orderId` is optional and defaults to an `ORD-` timestamp ID. It converts the supplied `amount` to the stored order total; server-side cart pricing is not implemented.

Example request body:

```json
{
  "orderId": "DOC-ORDER-001",
  "amount": 10,
  "customer": {
    "firstName": "Alex",
    "lastName": "Example",
    "email": "alex@example.com",
    "address": "100 Example Way",
    "city": "Kennesaw",
    "state": "GA",
    "zip": "30144"
  }
}
```

HTTP 201:

```json
{
  "success": true,
  "message": "Order created successfully.",
  "orderId": "DOC-ORDER-001",
  "orderTotal": 10,
  "orderStatus": "Pending"
}
```

Missing required customer fields return HTTP 400:

```json
{
  "success": false,
  "message": "Missing required customer order fields."
}
```

Database errors, including duplicate primary keys, return HTTP 500 with `success: false` and a `message`. Duplicate-ID HTTP 409 handling remains pending.

### POST `/api/payments`

The **current legacy request** uses `amount`, not `items`. The route checks customer/card presence and validates the card number before creating/updating the order and calling the gateway module. This is not yet the required server-priced checkout contract.

Request template, with nonfunctional sandbox placeholders:

```json
{
  "orderId": "DOC-ORDER-001",
  "amount": 10,
  "customer": {
    "firstName": "Alex",
    "lastName": "Example",
    "email": "alex@example.com",
    "address": "100 Example Way",
    "city": "Kennesaw",
    "state": "GA",
    "zip": "30144"
  },
  "cardNumber": "<SANDBOX_CARD_NUMBER>",
  "cardMonth": 12,
  "cardYear": 2030,
  "ccv": "<SANDBOX_SECURITY_CODE>",
  "cardType": "visa"
}
```

Authorization response shape, HTTP 200:

```json
{
  "success": true,
  "orderId": "DOC-ORDER-001",
  "status": "Authorized",
  "message": "Payment authorized successfully.",
  "authToken": "<REDACTED>",
  "expirationDate": "2030-12-31T23:59:59Z"
}
```

Illustrative processed-payment failure, HTTP 400:

```json
{
  "success": false,
  "orderId": "DOC-ORDER-001",
  "status": "Payment Failed",
  "message": "The payment authorization was declined."
}
```

Missing customer/card details also return HTTP 400, with `success`, `status: "Validation Error"`, and `message`. Invalid card numbers use `status: "Card Error"`. An order-insert failure returns HTTP 500 with `success`, `status`, and `message`.

The gateway module implements OAuth, a one-time refresh/retry after an authorization HTTP 401, request timeouts, and recognition of HTTP 200 with `Success: false`. However, the public handler converts processed gateway failures to HTTP 400 rather than forwarding the module's status codes. The current successful response does not include a calculated order total.

### POST `/api/settlements`

Looks up the latest **successful** authorization for the supplied Order ID. If the final amount does not exceed that authorization amount, it inserts a settlement record and updates the order to `Settled`. It does not call an external settlement/capture endpoint.

Example request body, assuming the order already has a successful authorization for 12:

```json
{
  "orderId": "DOC-ORDER-001",
  "finalAmount": 10
}
```

HTTP 200:

```json
{
  "message": "Successful settlement request received",
  "orderId": "DOC-ORDER-001",
  "finalAmount": 10,
  "authorizedAmount": 12
}
```

There is **no `success` boolean** in settlement responses. Creating a Pending order alone does not provide the successful authorization needed for settlement.

| HTTP status | Current meaning |
| --- | --- |
| 400 | Missing Order ID, NaN/negative amount, or final amount exceeding authorization |
| 404 | No successful authorization found for the Order ID |
| 500 | Database lookup, settlement insert, or order-status update failure |

Over-limit example for a requested amount of 13 against an authorization of 12, HTTP 400:

```json
{
  "message": "Failed settlement request: Final amount ($13.00) exceeds authorized amount ($12.00).",
  "finalAmount": 13,
  "authorizedAmount": 12
}
```

HTTP 404:

```json
{
  "message": "No successful payment authorization found for this Order ID."
}
```

One possible HTTP 500 response indicates that the settlement was already saved:

```json
{
  "message": "Settlement recorded, but failed to update order status."
}
```

Other settlement database errors also return a `message` field. A network error, invalid response, or HTTP 500 does not prove that nothing was saved. Verify the outcome before any further attempt. The frontend rejects zero and excessive decimal places; equivalent strict validation is still missing from the backend.

The application has no shared JSON error handler. Express-level errors, such as malformed request JSON, and unmatched routes may return non-JSON responses.

## Known Limitations and Pending Integration

| Area | Current limitation and remaining work |
| --- | --- |
| Storefront | Catalog/cart work is on `bassel-storefront`, awaiting integration. Product list/detail routes, assets, and shared styling must be reconciled before documenting them as available here. |
| Server-side pricing contract | Replace browser `amount` with `{ orderId, items: [{ productId, quantity }], customer, cardNumber, cardMonth, cardYear, ccv, cardType }`. The backend must validate items, price from SQLite, calculate in cents, and return the calculated total. This contract is not implemented yet. |
| OrderItems and database structure | Add `OrderItems`, atomic order/item creation, transaction helpers, and the agreed central database module/schema mirror. Back up and migrate existing databases, including authorization nullability and `FailureReason`, without discarding records. |
| Payment safety | Remove fabricated authorization/token/expiration fallbacks, validate all payment fields server-side, persist the gateway's authorized amount, and handle persistence failures reliably. The handler currently trusts browser totals and can report authorization despite a database authorization-insert error. New Order IDs per attempt and duplicate-ID HTTP 409 handling remain pending; current payment duplicates reset status to Pending. |
| Settlement safeguards | Enforce current Authorized status, reject already-settled or expired authorizations, validate positive cent-based amounts, and transact settlement/status updates atomically. Browser locks are not backend duplicate protection. Current comparisons use floating-point numbers. |
| Order detail and list correctness | Implement `GET /api/orders/:id` for warehouse authorization details and return one list row per order with its latest authorization. The warehouse currently cannot prefetch authorization amount/expiration. |
| Access control | API routes have no authentication/authorization middleware and CORS is unrestricted. Order responses contain customer details and authorization tokens even though the dashboard conceals tokens. |

After teammate integration, update the documented branch scope, page navigation, endpoint inventory, request/response examples, migration procedure, and these limitations to match the merged implementation.

## Verification status

Dashboard and warehouse changes have passed JavaScript syntax checks, `git diff --check`, and temporary in-memory mocked checks for safe rendering, query parameters, debounce/races, expiration formatting, validation, submission locks, response handling, and navigation.

Those temporary checks are not a committed test suite. `package.json` currently defines no `npm test` command. Real-browser layout, live gateway/database integration, and the complete storefront-to-settlement workflow remain unverified. End-to-end testing and milestone evidence still need to be recorded after integration.
