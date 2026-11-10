# Isolated browser testing

This launcher is available only in Group-9-System-Integration. It runs the actual
server/server.js, mounted Express routes, services and frontend assets. Only the
external Manhattan Associates OAuth/authorization transport is mocked.

The normal npm start and npm run dev commands do not enable these safeguards.
Use the dedicated launcher below for initial browser testing.

## Start

From a terminal:

~~~sh
cd /Users/basselsbaity/Desktop/Group-9-System-Integration

NODE_PATH=/Users/basselsbaity/Desktop/Group-9-Payment-Project/node_modules \
GROUP9_BROWSER_SCENARIO=approved \
PORT=3100 \
node scripts/browser-test-server.cjs
~~~

Existing dependencies are read from the sibling checkout; no installation or writes
to that checkout are needed. The launcher prints its exact URL, mock scenario and
temporary database path. If port 3100 is occupied, stop the conflicting test instance
or select another unused port and use the URL actually printed.

Every launch creates a brand-new directory under the OS temporary directory named
group9-browser-..., containing synthetic.sqlite. Only five synthetic catalog products
are initialized, with /img/p1.png through /img/p5.png; orders start empty.

## Isolation

- DB_PATH is replaced before any application import. The default database is opened
  and verified before Express starts. SQLite constructors reject all other filenames,
  including ecommerce.db and inherited DB_PATH values; there is no fallback.
- The database file is created exclusively with owner-only permissions.
- Synthetic merchant credentials replace inherited values. The server's dotenv call
  is redirected to the fresh temporary directory, avoiding project .env files.
- Gateway fetch calls are intercepted before loading the application. Only the exact
  OAuth/authorization mock URLs are recognized; nothing delegates to real fetch.
  Outbound HTTP, HTTPS, TCP and TLS connection entry points are also blocked.
- The actual server's listener is forced to 127.0.0.1, regardless of HOST settings.
- paymentService.js, production routes, frontend code and normal startup scripts are
  unchanged. These guards apply only inside the dedicated launcher process.

## URLs

| Page or endpoint | Local URL |
| --- | --- |
| Storefront | http://127.0.0.1:3100/ |
| Checkout | http://127.0.0.1:3100/checkout.html |
| Order dashboard | http://127.0.0.1:3100/orders.html |
| Warehouse | http://127.0.0.1:3100/warehouse.html |
| Server check | http://127.0.0.1:3100/api/test |
| Catalog | http://127.0.0.1:3100/api/products |
| Order details | http://127.0.0.1:3100/api/orders/REPLACE_WITH_TEST_ORDER_ID |

Use one browser tab for storefront-to-checkout navigation: the cart and payment
attempt marker use sessionStorage. Open Developer Tools and keep the Network panel
visible. Use a dedicated private browser session for each fresh launcher run.

## Approved purchase and settlements

1. Start the approved scenario. Open the storefront and verify all five PNG images.
   Test cart add/remove and quantity controls.
2. Add one Trail Backpack and continue to checkout in the same tab. The authoritative
   total should be $64.99. Do not open an empty checkout directly.
3. Enter synthetic details: Alex Example, alex@example.test, 100 Synthetic Way,
   City, ST, ZIP 00000. Use test card 4111 1111 1111 1111, expiration 12/35 and CVV 123.
   These are mock-only inputs, never real payment credentials.
4. Click Pay now. Try rapid clicks/Enter to verify one authorization per attempt.
   Expect confirmation, a fresh Order ID, cleared cart and cleared card/CVV fields.
5. Open the dashboard. Test Order ID/email/name search, status filtering, sorting,
   masked card display and the explicit-timezone authorization expiration.
6. Click Settle Order on the Authorized order. Verify Order ID prefilling.
7. Submit $65.00: expect HTTP 400 and an over-authorization message. The order should
   remain Authorized and the form should permit correction.
8. Submit $40.00: expect success, a locked form, and status Settled. Inspect the
   POST /api/settlements Network response for finalAmount 40, authorizedAmount 64.99
   and unusedAuthorizationAmount 24.99. The current page shows the success message,
   not a separate unused-amount label. No release or refund is performed.
9. Reopen warehouse.html?orderId=YOUR_TEST_ORDER_ID and submit the same order again.
   Expect HTTP 400, no second settlement record, and status still Settled.
10. Return to the store and create another approved order. A confirmed previous
    attempt permits a new checkout when a new cart exists. Settle the second $64.99
    order for exactly $64.99; expect unusedAuthorizationAmount 0.

## Other mock scenarios

Stop the current process before changing scenarios. Each restart uses a new
database, so also use a fresh private browser session; do not reuse old Order IDs.

Replace the scenario in the start command with:

| GROUP9_BROWSER_SCENARIO | Gateway result and expected application behavior |
| --- | --- |
| approved | Exact server-calculated amount; checkout success and Authorized order |
| declined | HTTP 200 with Success false and synthetic insufficient funds; HTTP 402 to checkout, cart retained, Payment Failed |
| payment-review | Approval for one cent above the requested amount; HTTP 502, actual authorization retained, Payment Review, cart retained and repayment blocked |

For declined, repeat the storefront/checkout steps. Verify the decline message,
retained cart, and Payment Failed dashboard entry. A deliberate retry should get a
new Order ID. Settlement must be rejected.

For payment-review, verify the review warning, retained cart and Payment Review
dashboard entry. A $64.99 order has an actual synthetic authorization of $65.00.
Clicks, Enter and reload must not submit another payment. Settlement must be
rejected. Do not clear an uncertain attempt marker to bypass the lock.

All synthetic approvals expire seven days after creation using explicit UTC
timestamps. Payments and settlement also accept valid full timezone-free timestamps
under the approved Manhattan mock UTC assumption; date-only values remain rejected.
Raw database history is preserved. This launcher does not establish the provider's
actual timezone contract.

## Stop

In the terminal running the launcher, press Ctrl+C. This sends SIGINT and closes
the listener and database. SIGTERM is also handled.

For a background instance, use only the PID belonging to that launcher:

~~~sh
kill -TERM YOUR_BROWSER_TEST_LAUNCHER_PID
~~~

The generated synthetic database is retained at the printed location for inspection.
The launcher never deletes an existing database or reuses a previous run's database.
Keep that printed path if you need the test history. Reloading the website after
shutdown should fail to connect. Do not stop unrelated project processes.

## Automated verification and limits

~~~sh
cd /Users/basselsbaity/Desktop/Group-9-System-Integration
NODE_PATH=/Users/basselsbaity/Desktop/Group-9-Payment-Project/node_modules npm test
~~~

Launcher tests use real child-process Express listeners on ephemeral loopback ports,
actual HTTP requests, exact frontend asset comparisons, and the existing frontend
scripts in a mocked DOM wired to those HTTP routes. They cover approved, declined,
review, duplicate payment, over/under/exact settlement, duplicate settlement,
configuration isolation, outbound blocking and graceful shutdown.

Automated test children are stopped and their generated temporary fixtures are
removed. Manual browser databases are retained. No persistent browser-test server
is started by running the suite.

Native browser layout, browser-specific behavior, and live gateway compatibility
still require separate verification. Settlement is the application's local SQLite
operation; these tests do not perform gateway capture, refunds, voids or fund release.
