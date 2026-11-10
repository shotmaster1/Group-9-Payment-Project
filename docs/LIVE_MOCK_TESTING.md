# External Manhattan Associates / Beeceptor mock API testing

This is a separate manual-testing launcher for the actual external capstone mock API.
It is not the simulated launcher on port 3100. Approval/decline outcomes may vary:
Manhattan Associates supplied project credentials but no guaranteed scenario cards.

No external request is made by importing the launcher or starting its server.
Only a deliberate checkout submission invokes OAuth/authorization.

## Start only after approval

The following command starts the site and enables real requests to the approved
mock host when you click Pay now. Do not run it before approval.

~~~sh
cd /Users/basselsbaity/Desktop/Group-9-System-Integration

NODE_PATH=/Users/basselsbaity/Desktop/Group-9-Payment-Project/node_modules \
GROUP9_LIVE_MOCK_APPROVED=YES \
GROUP9_MA_ENV_FILE=/Users/basselsbaity/Desktop/Group-9-Payment-Project/.env \
node scripts/live-mock-test-server.cjs
~~~

GROUP9_MA_ENV_FILE is a filename, not a secret value. The launcher reads only
MA_MERCHANT_ID and MA_SECRET_KEY from that private existing file into process memory.
It never changes or copies that file and does not display the values. Missing keys,
an invalid file, disabled TLS verification, or a missing approval flag fail closed.
The .env path must be absolute and name a regular, nonsymlink file.

The actual CLI always listens only at http://127.0.0.1:3101/. HOST and PORT environment
settings cannot expose the server or select another port. Automated tests use an
injected fake transport and an ephemeral loopback port; there is no CLI fake mode.

| Page | URL |
| --- | --- |
| Storefront | http://127.0.0.1:3101/ |
| Checkout, reached through the store | http://127.0.0.1:3101/checkout.html |
| Dashboard | http://127.0.0.1:3101/orders.html |
| Warehouse | http://127.0.0.1:3101/warehouse.html |

## Database and network isolation

Each launch creates a new private OS temporary directory named group9-live-mock-...
and initializes synthetic.sqlite with five PNG-based products and no orders,
authorizations or settlements. The SQLite constructor permits only that exact new
filename. Inherited DB_PATH and database settings in the credential file are ignored.
No existing ecommerce.db is opened, copied, migrated or modified.

The launcher installs its guards before loading the real server/server.js. Existing
routes, frontend code, gateway client, pricing and settlement policies are unchanged.
The server's dotenv call is redirected to the fresh temporary directory.

Only POST requests to these exact strings are permitted:

~~~text
https://capstoneproject.proxy.beeceptor.com/oauth/token
https://capstoneproject.proxy.beeceptor.com/authorize
~~~

Extra query strings, fragments, credentials in URLs, other paths/hosts/protocols,
or methods are blocked. Redirects are never followed, including same-host redirects.
The guarded fetch supplies its own headers and rejects non-test authorization inputs.
Direct HTTP/HTTPS requests are blocked. Socket creation is allowed only inside the
private approved transport context and only for the exact mock TLS host on port 443.
TLS certificate verification remains enabled.

An Order ID can reach the external authorization endpoint only once per process.
This also blocks an external replay after the production client's explicit 401
refresh path. The client may refresh OAuth, but a second authorization for that ID
is stopped before transport. No decline, timeout or uncertain authorization is
automatically resent. Database duplicate-ID checks and frontend locks remain active.

## Required synthetic browser inputs

The live-testing launcher rejects any customer/card inputs outside this set before
order creation. Its outgoing gateway guard independently enforces the test card.
The ordinary application's validation remains intact.

| Field | Input |
| --- | --- |
| First / last name | Alex / Example |
| Email | alex@example.test |
| Address | 100 Synthetic Way |
| City / state / ZIP | City / ST / 00000 |
| Test card | 4111 1111 1111 1111 |
| Card expiration | 12/35 |
| CVV | 123 |

This card is a synthetic application test input, not a Manhattan-provided scenario
card. It does not guarantee approval or decline. Do not substitute real card data,
real customer details or arbitrary cards to search for an outcome. The frontend
creates a random Order ID; do not manually replace it with customer information.

## First external attempt

1. Start with a fresh private browser session. Add one Trail Backpack and enter
   checkout in the same tab; verify the server quote is $64.99.
2. Fill only the synthetic inputs above. Click Pay now once. Do not refresh while
   the request is pending. There are no background gateway probes or status polls.
3. Record the displayed Order ID and outcome. Inspect the sanitized terminal/file
   diagnostics for HTTP statuses, response field types, amount/ID matching and
   expiration classification. Do not copy raw request headers or gateway tokens.
4. If the result is uncertain, Payment Review, timed out, or has an unsupported
   expiration, stop. Keep the cart and attempt marker, and verify status with the
   team/provider. Never clear locks or restart solely to repeat an uncertain payment.
5. If declined, expect Payment Failed and a retained cart. Do not automatically
   repeat. A later explicitly approved manual attempt receives a fresh Order ID.
   If the provider never produces a decline, mark external decline coverage
   unverified; do not claim the earlier simulated decline proves provider behavior.

Success requires the existing exact amount match, matching Order ID, usable actual
authorization token, and a future timestamp accepted by the shared authorization
policy. The approved mock-only convention interprets valid full timezone-free
values such as 2027-03-31T00:00:00.000 as UTC. Date-only, missing, malformed,
impossible and expired dates remain blocked. This convention is not provider
confirmation of UTC. SQLite preserves the exact provider string; the frontend
receives the normalized UTC value. Existing Payment Review orders remain held and
are never promoted or retried automatically.

## Warehouse checks after confirmed authorization

Only after the order is actually Authorized:

1. Open the dashboard; verify masking, status and authorization expiration.
2. Click Settle Order and verify Order ID prefilling.
3. For the $64.99 authorization, request $65.00: expect HTTP 400 without a settlement.
4. Correct to $40.00: expect success and unusedAuthorizationAmount 24.99 in the local
   POST /api/settlements response. Repeating that order must be rejected.
5. Confirm dashboard/order-detail status Settled and one settlement record.

These settlement operations affect only the temporary local database. There is no
external capture, refund, void or authorization-release request. The unused amount
is arithmetic reporting, not proof of released funds. Declined/review orders remain
ineligible for settlement.

## Sanitized diagnostics

The launcher prints and writes gateway-sanitized.jsonl in its private temporary
directory. Both log and database are created with owner-only permissions. The log
contains local timestamps, endpoint labels, request/header/response/error phases,
HTTP status codes, whitelisted field names and types, unknown-field counts, and
categorical compatibility flags. It never records request bodies, response values,
unknown field names, headers, card fields, credentials, tokens, raw errors, or Order IDs.

For expiration, it reports date-only, explicit-timezone, full timezone-free,
timezone-free-or-malformed, missing, non-string or unrecognized, plus validity under
the shared authorization policy. For accepted timezone-free values it reports only
the categorical expirationAssumption manhattan-mock-utc, not the raw expiration.
These observations are diagnostics only; they never change the application's decision.
Logs and database remain outside Git. The temporary database necessarily contains
actual mock authorization results/tokens and must also stay private.

## Stop and verification limits

Press Ctrl+C in the launch terminal to close the listener and database. SIGTERM is
also handled. Temporary files remain at the printed paths for local investigation;
every new launch uses a different database.

~~~sh
kill -TERM YOUR_LIVE_MOCK_LAUNCHER_PID
~~~

Do not stop unrelated processes, delete the project database, or reuse old Order IDs
after restarting. No dependency installation is needed.

Automated verification injects fake transports and synthetic credentials. It tests
allowlisting, redirect rejection, sanitization, replay prevention, data isolation,
expiration policies and real frontend/HTTP routes without contacting Beeceptor.
Passing those tests establishes launcher behavior, not live gateway compatibility.
