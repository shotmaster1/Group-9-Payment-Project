# Settlement safeguards — Stage 6

## Authorization expiration policy (agreed before implementation)

The existing AuthExpirationDate column is TEXT and the payment producer has stored
both date-only values (for example 2028-12-31) and timestamps. Neither the schema
nor producer defines a timezone or cutoff for a date-only expiration.

The project owner explicitly chose to **reject date-only expirations until the
gateway contract defines their meaning**. Stage 6 does not interpret these values
as midnight or end-of-day in any timezone, repair them, or invent a replacement.
The real database and payment integration are not changed.

Accepted expiration values must be valid ISO calendar timestamps with an explicit
`Z` or `+HH:MM` / `-HH:MM` timezone. Missing, blank, malformed, impossible-calendar,
timezone-free, and date-only values are definite settlement rejections (HTTP 400).
The parser will not rely on Date.parse normalizing invalid calendar dates.

An authorization is valid only when the backend clock is strictly before its
expiration instant: `now < expiresAt`. Equality is expired. Offsets are converted
to the same UTC instant; the host timezone never determines validity. The check
occurs inside the settlement transaction immediately before persistence, after
waiting for its database lock. SettlementDate is a UTC ISO timestamp from that
same clock reading. Dates and timestamps are never rewritten in stored history.

## Payment expiration compatibility limitation

Static inspection of the currently loaded payment path shows that date-only values
can reach settlement without being rejected during authorization:

- server/server.js:13 loads the root `Payment API` module. Its processPayment
  success mapping at Payment API:314 passes `data.TokenExpirationDate` through as
  tokenExpirationDate without enforcing a timestamp/timezone. It can therefore
  return a date-only value if the provider supplies one.
- server/server.js:126 uses `authResultData.tokenExpirationDate || "2028-12-31"`.
  Missing, NULL, or empty expiration values become this ambiguous date-only fallback.
- server/server.js:136 stores that value unchanged in AuthExpirationDate, and
  server/server.js:148 returns it as expirationDate. The handler can still report
  Authorized even though Stage 6 will reject that record for settlement.

| Provider expiration / application path | Stored expiration | Stage 6 result, assuming other eligibility checks pass |
| --- | --- | --- |
| `2030-01-02T00:00:00Z` | Same timestamp | Accepted only before that instant |
| `2030-01-01T19:00:00-05:00` | Same timestamp | Accepted only before that same UTC instant |
| `2030-01-02` | Same date-only text | HTTP 400; no settlement or status change |
| Missing, NULL, or empty | Legacy fallback `2028-12-31` | HTTP 400; no settlement or status change |
| Timestamp without a timezone | Same ambiguous text | HTTP 400; no settlement or status change |

**Workflow impact:** normal authorization-to-settlement is blocked whenever an
otherwise successful authorization supplies a date-only expiration, or the current
server uses its missing-expiration fallback. Authorization can succeed while the
subsequent warehouse settlement is rejected. A valid future explicit-timezone
timestamp remains supported. These are conditional code-path findings, not a
claim that the live gateway normally returns date-only values.

No authoritative provider expiration-format/cutoff contract or captured live
response was verified in this inspection. No live payment request was made and
no historical database records were read, so the provider's usual format and the
number of affected existing orders remain unverified. The server's initial fake
success default at server/server.js:97 contains a zoned timestamp; it must not be
used as a workaround or treated as evidence of genuine authorization.

Mocked regression checks execute the existing payment adapter and unchanged legacy
payment handler with synthetic provider responses and temporary SQLite fixtures,
then exercise settlement. Startup/listening, environment loading, and card validation
are intercepted; no real card data or credentials are used. This confirms pass-through, missing-value fallback,
400 rejection without writes, and continued support for explicit-timezone values.
The adapter, payment handler, real database, and approved Stage 6 policy are not
changed. Confirm the provider's date-only timezone and cutoff with the gateway/team
before requesting any policy change; do not append a timezone, invent a cutoff,
or repair old records automatically. Quentin's Payment API2 remains untouched.

## POST /api/settlements

The request remains `{ "orderId": "SYNTHETIC-001", "finalAmount": 80 }`.
Only these two own data fields are accepted. Order IDs must be nonblank strings;
lookups preserve exact text, with SQL parameters rather than string interpolation.
Browser-provided authorization amounts, clocks, or computed unused amounts are rejected.

`finalAmount` may be a numeric dollar value (as sent by PR #5) or a plain decimal
string accepted by moneyService. It must be positive, finite, within the safe
integer-cent range, have no more than two decimal places, and round-trip safely
through the numeric-dollar response. Blank strings, whitespace, booleans, arrays,
objects, signs/exponent notation in strings and excessive precision are rejected.
Trailing zeros lost by JavaScript/JSON numbers cannot be recovered; decimal strings
such as `"1.000"` are rejected rather than rounded.

HTTP 200, with synthetic data:

```json
{
  "message": "Successful settlement request received",
  "orderId": "SYNTHETIC-001",
  "finalAmount": 80,
  "authorizedAmount": 100,
  "unusedAuthorizationAmount": 20
}
```

The four existing fields and message are preserved. All amount fields are numeric
dollars. `unusedAuthorizationAmount` is the only added success field, and is zero
for an exact settlement. Under-settlements and exact settlements succeed; requests
above the stored authorization amount are rejected. The original order total is
not the authorization limit. No success boolean is required or added.

Unused authorization is arithmetic reporting only: **no refund, release, void,
or payment capture request is performed or implied**. This service records a local
settlement and changes the order status. It does not contact any payment provider.

| HTTP status | Conditions / response |
| --- | --- |
| 400 | Invalid body/ID/amount; status other than Authorized; unsuccessful latest authorization; missing/invalid/expired expiration; unusable authorization amount; existing settlement history; over-limit amount |
| 404 | Missing order, or an Authorized order with no authorization record |
| 500 | Database/transaction/write-count failure, rollback failure, or invalid backend clock |

Every error contains `message`. Over-limit errors also preserve numeric
`finalAmount` and `authorizedAmount`. SQLite details, SQL, card data, and tokens
are not included in responses. Unexpected failures use this message:

```json
{
  "message": "Settlement could not be confirmed. Verify the order status before attempting another settlement."
}
```

No 409/410/422 or other new error status is introduced. PR #5 treats 400/404 as
definite rejections that allow correction, and 500/network failure as uncertain
outcomes that lock the form pending verification. Its existing success validation
accepts the additional field. It does not yet display that field separately.
The HTML, Order ID prefill, navigation, and frontend code are not changed.

## Atomic eligibility and persistence

`settlementService.settleOrder(input, { database, now })` owns one managed
transaction and returns only after commit. Options are backend-only: database
defaults to the lazy central facade, and now defaults to Date.now. The injected
clock must return integer epoch milliseconds within the JavaScript Date range.
Tests always inject synthetic connections and, except lazy-default tests, a fixed
clock. Importing this module does not open the default database.

The central helper takes BEGIN IMMEDIATE before reading eligibility. Within that
same scope the service:

1. Requires the stored order status to equal Authorized.
2. Reads the highest AuthorizationID overall, without filtering out failed records;
   its AuthorizationResult must equal Success. It never falls back to an older approval.
3. Rejects **any existing settlement row** for that Order ID, including rejected or
   inconsistent legacy history. Such records require review; they are never deleted,
   consolidated, or retried automatically. Existing historical duplicates remain intact.
4. Validates the recorded AuthorizationAmount using moneyService and compares
   integer cents. Both stored and requested amounts must be positive and representable.
5. Computes the nonnegative integer-cent difference, then validates its numeric-dollar
   representation with fromCents. No floating-point dollar subtraction is used.
6. Validates expiration and reads the backend clock immediately before the first write.
7. Inserts one Success settlement and conditionally changes Authorized to Settled.
   Each write must affect exactly one row; ignored writes are failures too.

Concurrent submissions on one or multiple connections serialize through SQLite's
write lock. After one commits, the next observes Settled status/history and receives
400. The service does not add a uniqueness constraint incompatible with historical
records, alter the schema, change authorizations, or write unsuccessful attempts.

The existing central transaction helper rolls back failures and allows ordinary
SQL failures to recover. If ROLLBACK itself fails, it preserves the original error,
attaches rollbackError, and blocks the connection with DB_TRANSACTION_STATE_UNKNOWN.
No success is returned, no automatic retry occurs, and the order must be verified
using a trustworthy connection before further actions. An unknown outcome must
never be described as a confirmed rollback or success. Recovery of such a connection
requires close/reopen; the service does not silently replace it or replay the request.

## Exact expiration grammar

Accepted text is `YYYY-MM-DDTHH:mm[:ss[.fraction]]Z` or the same followed by a
signed `HH:MM` offset instead of Z. Fields use two digits, years use four digits,
seconds (if present) are 00–59, and fractional seconds contain 1–9 digits. Offset
hours are 00–23 and minutes are 00–59. Surrounding whitespace, lowercase z,
leap seconds, 24:00, invalid offsets and impossible dates are rejected.

Calendar validation uses UTC and verifies the original calendar date rather than
normalizing values such as February 30. Offset conversion and up to nine fractional
digits are compared as integer nanoseconds against the millisecond backend clock,
so sub-millisecond expiration instants are not truncated into an earlier expiry.
No BigInt value is returned in JSON. A timestamp one nanosecond after the current
millisecond remains valid; equality or any later backend clock reading is expired.

## Verification and remaining integration

Synthetic temporary SQLite tests cover under/exact/over amounts, unused cents,
request validation/overflow, invalid stored amounts, highest-ID approvals/declines,
all eligibility states, missing and invalid expirations, timezone offsets, leap
calendar dates, exact and sub-millisecond expiration boundaries, lock-wait expiry,
queued input snapshots, repeated/concurrent submissions on one or two connections,
historical duplicates/rejected records, failures/ignored writes at either write,
queue recovery, and the rollback-error connection quarantine path.

API checks run the actual Express router in process without a listening socket.
Frontend compatibility checks execute the unchanged warehouse script from
bassel-dashboard-security against the tested handler with a mocked DOM/fetch.
They verify prefilling, loading, double-submit prevention, success locking, 400/404
correction, and uncertain-outcome locking after 500. These are automated mocked
checks, not a live browser or gateway test. The original Stage 1–5 tests also run.

```sh
NODE_PATH=../Group-9-Payment-Project/node_modules npm test
```

The real ecommerce.db is never opened or migrated. No dependencies are added.
Payment integration and Quentin's newly pushed Payment API2 are not modified.
The existing payment handler still has its documented amount/fallback/persistence
issues: these safeguards validate stored records, not the authenticity of a gateway
approval. Payment integration must persist the actual approved amount and trustworthy
expiration before end-to-end settlement behavior can be certified. Date-only records
remain ineligible until that contract is defined. Frontend integration/display of
unused amounts remains separate work. No later stage has started.
