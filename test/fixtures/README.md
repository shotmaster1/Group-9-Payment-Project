# Historical settlement regression fixture

legacy-server.js.txt is a byte-for-byte snapshot of server/server.js from integration
checkpoint 00d8161f1b8b7468769fb88fbb81223d4f98d1f8. That identifier records provenance;
tests never resolve it or require Git history.

SHA-256: 7b3da51c47ac1d44dac9342cb068162a4c70425d0abf742ff2ad00841cb88c9b.

The fixture preserves the historical payment handler, including its unsafe fallback
behavior, solely to verify compatibility with existing authorization records.
It is archived text, not an application module. Do not require or run it as a server.

test/settlements.test.js reads this source and executes it in its existing VM harness.
The harness intercepts Express startup, dotenv loading, validation, database access
and gateway transport. All records and gateway responses are synthetic; no listener,
real credentials, project database or external requests are used by this regression.

The historical scenarios retain their exact stored expiration values and assertions
about preservation. Date-only, missing, null and blank values remain rejected.
Full timezone-free timestamps now settle under the explicitly approved Manhattan
mock UTC assumption, alongside explicit UTC/offset timestamps. Accepted settlements
report $20 unused on a $100 authorization settled for $80; rejected settlements leave
records intact. Current payment behavior has separate coverage for malformed/expired
values, UTC normalization, and continued removal of fake-success fallbacks.

The warehouse compatibility tests read client/js/settlement.js from the current
source tree. Its contents matched PR #5 byte-for-byte when removing the old branch
lookup, and all existing assertions remain. Tests run without a .git directory,
historical objects, local branches or Git installed.
