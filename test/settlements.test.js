"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { createDatabase } = require("../server/database/database");
const { settleOrder, SettlementError } = require("../server/services/settlementService");

const instant = Date.parse("2030-01-01T12:00:00.000Z");
const expiry = "2030-01-01T12:00:01.000Z";
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-stage6-"));
    const filename = path.join(directory, "synthetic.sqlite");
    const connections = [];
    t.after(async () => {
        await Promise.all(connections.map(db => db.closeAsync()));
        fs.rmSync(directory, { recursive: true });
    });
    return { filename, open() { const db = createDatabase({ filename }); connections.push(db); return db; } };
}
async function seed(db, id = "SYNTHETIC", { status = "Authorized", amount = 100, expiration = expiry, result = "Success", date = "2030-01-01T00:00:00Z" } = {}) {
    await db.runAsync(`INSERT INTO Orders
        (OrderID, CustomerName, CustomerEmail, ShippingAddress, City, State, Zip, OrderDate, OrderTotal, OrderStatus)
        VALUES (?, 'Alex Example', 'alex@example.test', 'Synthetic', '', '', '', ?, 150, ?)`, [id, date, status]);
    await addAuthorization(db, id, amount, expiration, result, date);
}
async function addAuthorization(db, id, amount, expiration = expiry, result = "Success", date = "2030-01-01T00:00:00Z") {
    return db.runAsync(`INSERT INTO PaymentAuthorizations
        (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult)
        VALUES (?, NULL, ?, ?, ?, ?)`, [id, amount, date, expiration, result]);
}
const request = (orderId = "SYNTHETIC", finalAmount = 80) => ({ orderId, finalAmount });
const options = database => ({ database, now: () => instant });
async function unchanged(db, id = "SYNTHETIC", status = "Authorized") {
    assert.equal((await db.getAsync("SELECT OrderStatus FROM Orders WHERE OrderID = ?", [id])).OrderStatus, status);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements WHERE OrderID = ?", [id])).count, 0);
}
const errorCode = code => error => error instanceof SettlementError && error.code === code;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("under-settlement returns existing success fields plus unused amount and commits both writes", async t => {
    const db = fixture(t).open(); await seed(db);
    const beforeAuth = await db.allAsync("SELECT * FROM PaymentAuthorizations");
    const result = await settleOrder(request(), options(db));
    assert.deepEqual(result, { message: "Successful settlement request received", orderId: "SYNTHETIC", finalAmount: 80, authorizedAmount: 100, unusedAuthorizationAmount: 20 });
    assert.deepEqual(await db.getAsync("SELECT * FROM Settlements"), { SettlementID: 1, OrderID: "SYNTHETIC", FinalShipmentAmount: 80, SettlementDate: "2030-01-01T12:00:00.000Z", SettlementResult: "Success" });
    assert.equal((await db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Settled");
    assert.deepEqual(await db.allAsync("SELECT * FROM PaymentAuthorizations"), beforeAuth);
    assert.deepEqual(await db.allAsync("PRAGMA foreign_key_check"), []);
});

test("exact settlement is accepted with zero unused authorization", async t => {
    const db = fixture(t).open(); await seed(db);
    assert.equal((await settleOrder(request("SYNTHETIC", 100), options(db))).unusedAuthorizationAmount, 0);
});

test("over-settlement is rejected against authorization amount rather than original order total", async t => {
    const db = fixture(t).open(); await seed(db);
    await assert.rejects(settleOrder(request("SYNTHETIC", 120), options(db)), error => {
        assert.equal(error.code, "OVER_AUTHORIZATION"); assert.equal(error.statusCode, 400);
        assert.deepEqual(error.details, { finalAmount: 120, authorizedAmount: 100 }); return true;
    });
    await unchanged(db);
});

test("cent comparisons and unused calculations are exact for decimal amounts", async t => {
    const db = fixture(t).open();
    for (const [id, amount, finalAmount, expected] of [["A", 0.3, 0.1, 0.2], ["B", 19.99, "7.89", 12.1], ["C", 0.01, "0.01", 0]]) {
        await seed(db, id, { amount });
        const result = await settleOrder(request(id, finalAmount), options(db));
        assert.equal(result.finalAmount, Number(finalAmount)); assert.equal(result.unusedAuthorizationAmount, expected);
    }
    await seed(db, "OVER-CENT", { amount: 0.3 });
    await assert.rejects(settleOrder(request("OVER-CENT", 0.31), options(db)), errorCode("OVER_AUTHORIZATION"));
});

test("invalid request amounts fail before any database use", async () => {
    let calls = 0; const database = { withTransaction() { calls++; throw new Error("No database access expected"); } };
    const amounts = [undefined, null, "", " ", " 1.00", "1.00 ", 0, -0, -1, "-1", "0.00", false, true, NaN, Infinity, -Infinity, "Infinity", "NaN", [], {}, [80], "abc", "1e2", "1,000", "+1", ".50", "1.", 1.001, "1.000", 0.1 + 0.2, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, "90071992547409.91", "90071992547409.92", "99999999999999999999999999"];
    for (const finalAmount of amounts) await assert.rejects(settleOrder({ orderId: "SYNTHETIC", finalAmount }, { database }), errorCode("INVALID_AMOUNT"));
    assert.equal(calls, 0);
});

test("malformed bodies, IDs, extra fields and getters are rejected without database access", async () => {
    let calls = 0, read = false;
    const database = { withTransaction() { calls++; throw new Error("No database access expected"); } };
    for (const input of [null, undefined, [], "request", {}, ...[null, undefined, "", " \n", 1, true, [], {}].map(orderId => ({ orderId, finalAmount: 80 })), { ...request(), authorizedAmount: 100 }, { ...request(), now: instant }]) {
        await assert.rejects(settleOrder(input, { database }), error => error instanceof SettlementError && error.statusCode === 400);
    }
    await assert.rejects(settleOrder({ get orderId() { read = true; return "SYNTHETIC"; }, finalAmount: 80 }, { database }), errorCode("INVALID_REQUEST"));
    assert.equal(read, false); assert.equal(calls, 0);
});

test("missing orders return 404 without creating settlement history", async t => {
    const db = fixture(t).open();
    await assert.rejects(settleOrder(request("MISSING"), options(db)), error => error.code === "ORDER_NOT_FOUND" && error.statusCode === 404);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
});

test("only exact Authorized order status is eligible", async t => {
    const db = fixture(t).open();
    for (const status of ["Pending", "Payment Failed", "Settled", "Cancelled", "authorized", "Unknown", ""]) {
        const id = "STATUS-" + status; await seed(db, id, { status });
        await assert.rejects(settleOrder(request(id), options(db)), errorCode("ORDER_NOT_AUTHORIZED"));
        await unchanged(db, id, status);
    }
});

test("Authorized orders without an authorization return 404", async t => {
    const db = fixture(t).open(); await seed(db);
    await db.runAsync("DELETE FROM PaymentAuthorizations");
    await assert.rejects(settleOrder(request(), options(db)), error => error.code === "AUTHORIZATION_NOT_FOUND" && error.statusCode === 404);
    await unchanged(db);
});

test("latest authorization is selected by highest ID overall and never falls back after a decline", async t => {
    const db = fixture(t).open(); await seed(db, "SYNTHETIC", { date: "2099-01-01" });
    await addAuthorization(db, "SYNTHETIC", 100, expiry, "Failed", "2000-01-01");
    await assert.rejects(settleOrder(request(), options(db)), errorCode("AUTHORIZATION_UNSUCCESSFUL"));
    await unchanged(db);
    await addAuthorization(db, "SYNTHETIC", 90, expiry, "Success", "1999-01-01");
    const result = await settleOrder(request(), options(db));
    assert.equal(result.authorizedAmount, 90); assert.equal(result.unusedAuthorizationAmount, 10);
});

test("declined, failed and unknown authorization results are rejected", async t => {
    const db = fixture(t).open();
    for (const result of ["Failed", "Declined", "Error", "Pending", "success", "Approved", ""]) {
        const id = "RESULT-" + result; await seed(db, id, { result });
        await assert.rejects(settleOrder(request(id), options(db)), errorCode("AUTHORIZATION_UNSUCCESSFUL"));
        await unchanged(db, id);
    }
});

test("invalid stored authorization amounts are rejected without writing", async t => {
    const db = fixture(t).open();
    for (const [index, amount] of [0, -1, 1.001, "invalid", Infinity, Number.MAX_VALUE, 90071992547409.92].entries()) {
        const id = "BAD-AUTH-" + index; await seed(db, id, { amount });
        await assert.rejects(settleOrder(request(id, 0.01), options(db)), errorCode("INVALID_AUTHORIZED_AMOUNT"));
        await unchanged(db, id);
    }
});

test("missing, malformed, date-only and timezone-free expirations are rejected", async t => {
    const db = fixture(t).open();
    const values = [null, "", " ", "2030-01-02", "2030-01-01T12:00:01", "2030-01-01 12:00:01Z", "01/02/2030", "tomorrow", " 2030-01-02T00:00:00Z", "2030-01-02T00:00:00Z ", "2030-01-02T00:00:00z", "2030-01-01T12:00:00.1234567890Z"];
    for (const [index, expiration] of values.entries()) {
        const id = "BAD-EXP-" + index; await seed(db, id, { expiration });
        await assert.rejects(settleOrder(request(id), options(db)), errorCode("INVALID_EXPIRATION"));
        await unchanged(db, id);
    }
});

test("impossible calendars, leap seconds and out-of-range time/offset fields are rejected", async t => {
    const db = fixture(t).open();
    for (const [index, expiration] of ["2030-02-29T12:00:00Z", "2030-02-30T12:00:00Z", "2030-04-31T12:00:00Z", "2030-00-01T12:00:00Z", "2030-13-01T12:00:00Z", "2030-01-00T12:00:00Z", "2030-01-01T24:00:00Z", "2030-01-01T12:60:00Z", "2030-01-01T12:00:60Z", "2030-01-01T12:00:00+24:00", "2030-01-01T12:00:00-05:60"].entries()) {
        const id = "RANGE-" + index; await seed(db, id, { expiration });
        await assert.rejects(settleOrder(request(id), options(db)), errorCode("INVALID_EXPIRATION"));
        await unchanged(db, id);
    }
});

test("expiration boundary accepts one millisecond before and rejects equality or later", async t => {
    const db = fixture(t).open();
    const expiresAt = Date.parse(expiry);
    for (const [id, now, accepted] of [["BEFORE", expiresAt - 1, true], ["EQUAL", expiresAt, false], ["AFTER", expiresAt + 1, false]]) {
        await seed(db, id);
        const result = settleOrder(request(id), { database: db, now: () => now });
        if (accepted) assert.equal((await result).finalAmount, 80);
        else { await assert.rejects(result, errorCode("AUTHORIZATION_EXPIRED")); await unchanged(db, id); }
    }
});

test("explicit offsets denote the same expiration instant independent of host timezone", async t => {
    const db = fixture(t).open();
    for (const [index, expiration] of ["2030-01-01T12:00:01Z", "2030-01-01T07:00:01-05:00", "2030-01-01T17:30:01+05:30"].entries()) {
        const id = "OFFSET-" + index; await seed(db, id, { expiration });
        await assert.rejects(settleOrder(request(id), { database: db, now: () => instant + 1000 }), errorCode("AUTHORIZATION_EXPIRED"));
        assert.equal((await settleOrder(request(id), { database: db, now: () => instant + 999 })).finalAmount, 80);
    }
});

test("fractional seconds retain nanosecond precision and minute-only zoned timestamps are supported", async t => {
    const db = fixture(t).open();
    await seed(db, "NANO", { expiration: "2030-01-01T12:00:00.000000001Z" });
    assert.equal((await settleOrder(request("NANO"), options(db))).finalAmount, 80);
    await seed(db, "NANO-AFTER", { expiration: "2030-01-01T12:00:00.000000001Z" });
    await assert.rejects(settleOrder(request("NANO-AFTER"), { database: db, now: () => instant + 1 }), errorCode("AUTHORIZATION_EXPIRED"));
    await seed(db, "MINUTE", { expiration: "2030-01-01T12:01Z" });
    assert.equal((await settleOrder(request("MINUTE"), options(db))).finalAmount, 80);
    await seed(db, "LEAP", { expiration: "2032-02-29T00:00:00Z" });
    assert.equal((await settleOrder(request("LEAP"), options(db))).finalAmount, 80);
});

test("a later invalid expiration never falls back to an older valid approval", async t => {
    const db = fixture(t).open(); await seed(db);
    await addAuthorization(db, "SYNTHETIC", 100, "2099-01-01");
    await assert.rejects(settleOrder(request(), options(db)), errorCode("INVALID_EXPIRATION"));
    await unchanged(db);
});

test("repeated successful submissions cannot add new settlements", async t => {
    const db = fixture(t).open(); await seed(db);
    await settleOrder(request(), options(db));
    const before = await db.allAsync("SELECT * FROM Settlements");
    await assert.rejects(settleOrder(request(), options(db)), errorCode("ORDER_NOT_AUTHORIZED"));
    assert.deepEqual(await db.allAsync("SELECT * FROM Settlements"), before);
});

test("historical duplicate settlements remain byte-for-value intact and block new records even if status is Authorized", async t => {
    const db = fixture(t).open(); await seed(db);
    for (const id of [9, 18]) await db.runAsync("INSERT INTO Settlements VALUES (?, 'SYNTHETIC', 10, '2029-01-01', 'Success')", [id]);
    const before = await db.allAsync("SELECT * FROM Settlements ORDER BY SettlementID");
    await assert.rejects(settleOrder(request(), options(db)), errorCode("ALREADY_RECORDED"));
    assert.deepEqual(await db.allAsync("SELECT * FROM Settlements ORDER BY SettlementID"), before);
    assert.equal((await db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Authorized");
});

test("a rejected historical settlement also requires review rather than creating another history row", async t => {
    const db = fixture(t).open(); await seed(db);
    await db.runAsync("INSERT INTO Settlements VALUES (1, 'SYNTHETIC', 10, '2029-01-01', 'Rejected')");
    await assert.rejects(settleOrder(request(), options(db)), errorCode("ALREADY_RECORDED"));
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 1);
});

test("simultaneous requests on one connection produce exactly one settlement", async t => {
    const db = fixture(t).open(); await seed(db);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => settleOrder(request(), options(db))));
    assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    assert.ok(results.filter(row => row.status === "rejected").every(row => row.reason instanceof SettlementError && row.reason.statusCode === 400));
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 1);
});

test("simultaneous requests across independent connections produce exactly one settlement", async t => {
    const f = fixture(t), first = f.open(); await seed(first);
    const second = f.open(); await second.ready;
    const results = await Promise.allSettled([settleOrder(request(), options(first)), settleOrder(request(), options(second))]);
    assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(results.filter(row => row.status === "rejected").length, 1);
    assert.equal((await first.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 1);
    assert.equal((await first.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Settled");
});

test("settlement insert failures roll back without changing order status", async t => {
    const db = fixture(t).open(); await seed(db);
    await db.runAsync("CREATE TRIGGER RejectSettlement BEFORE INSERT ON Settlements BEGIN SELECT RAISE(ABORT, 'synthetic internal detail'); END");
    await assert.rejects(settleOrder(request(), options(db)), { code: "SQLITE_CONSTRAINT" });
    await unchanged(db);
    await db.runAsync("DROP TRIGGER RejectSettlement");
    assert.equal((await settleOrder(request(), options(db))).finalAmount, 80);
});

test("status-update failure rolls back an already inserted settlement and recovers the queue", async t => {
    const db = fixture(t).open(); await seed(db);
    await db.runAsync("CREATE TRIGGER RejectStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ABORT, 'synthetic update failure'); END");
    await assert.rejects(settleOrder(request(), options(db)), { code: "SQLITE_CONSTRAINT" });
    await unchanged(db);
    await db.runAsync("DROP TRIGGER RejectStatus");
    assert.equal((await settleOrder(request(), options(db))).finalAmount, 80);
});

test("ignored insert or status update cannot report success or leave partial writes", async t => {
    const db = fixture(t).open(); await seed(db);
    await db.runAsync("CREATE TRIGGER IgnoreSettlement BEFORE INSERT ON Settlements BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(settleOrder(request(), options(db)), /insert did not save/); await unchanged(db);
    await db.runAsync("DROP TRIGGER IgnoreSettlement");
    await db.runAsync("CREATE TRIGGER IgnoreStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(settleOrder(request(), options(db)), /status update did not save/); await unchanged(db);
});

test("rollback failure preserves the original error, quarantines the connection and never reports success", async t => {
    const f = fixture(t), db = f.open(); await seed(db);
    const observer = f.open(); await observer.ready;
    // SQLite rolls back the transaction itself. The central helper's subsequent
    // ROLLBACK then fails: this is a real rollback-error path, not a mock.
    await db.runAsync("CREATE TRIGGER RollbackStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ROLLBACK, 'synthetic automatic rollback'); END");
    await assert.rejects(settleOrder(request(), options(db)), error => error.code === "SQLITE_CONSTRAINT" && error.rollbackError?.code === "SQLITE_ERROR");
    await assert.rejects(db.getAsync("SELECT 1"), { code: "DB_TRANSACTION_STATE_UNKNOWN" });
    await unchanged(observer);
});

test("clock and request data are checked after waiting for a transaction lock", async t => {
    const db = fixture(t).open(); await seed(db);
    const entered = deferred(), release = deferred();
    const held = db.withTransaction(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let current = instant, calls = 0;
    const body = request();
    const pending = settleOrder(body, { database: db, now: () => { calls++; return current; } });
    body.orderId = "OTHER"; body.finalAmount = 1;
    current = instant + 1000;
    const rejected = assert.rejects(pending, errorCode("AUTHORIZATION_EXPIRED"));
    release.resolve(); await held; await rejected;
    assert.equal(calls, 1); await unchanged(db);
});

test("queued input snapshots preserve Order ID and amount", async t => {
    const db = fixture(t).open(); await seed(db);
    const entered = deferred(), release = deferred();
    const held = db.withTransaction(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const body = request(); const pending = settleOrder(body, options(db));
    body.orderId = "OTHER"; body.finalAmount = 1;
    release.resolve(); await held;
    assert.deepEqual(await pending, { message: "Successful settlement request received", orderId: "SYNTHETIC", finalAmount: 80, authorizedAmount: 100, unusedAuthorizationAmount: 20 });
});

test("literal IDs are bound safely and existing related order data remain unchanged", async t => {
    const db = fixture(t).open(), id = "  literal' OR 1=1 --  ";
    await seed(db, id); await seed(db, "OTHER");
    const before = await db.getAsync("SELECT * FROM Orders WHERE OrderID='OTHER'");
    assert.equal((await settleOrder(request(id), options(db))).orderId, id);
    assert.deepEqual(await db.getAsync("SELECT * FROM Orders WHERE OrderID='OTHER'"), before);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 2);
});

test("invalid backend clock and database failures never create partial settlement records", async t => {
    const db = fixture(t).open(); await seed(db);
    for (const value of [NaN, Infinity, undefined, "2030-01-01", instant + 0.5, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(settleOrder(request(), { database: db, now: () => value }), /clock is invalid/); await unchanged(db);
    }
    await db.closeAsync(); await assert.rejects(settleOrder(request(), options(db)), { code: "DB_CLOSED" });
    await assert.rejects(settleOrder(request(), { database: {}, now: () => instant }), TypeError);
    await assert.rejects(settleOrder(request(), { database: db, now: 123 }), TypeError);
});

test("service import is lazy and default settlement uses only an explicit synthetic DB_PATH", t => {
    const f = fixture(t);
    const code = [
        'const assert=require("node:assert/strict"),fs=require("node:fs");',
        'const service=require(process.argv[1]),db=require(process.argv[2]);',
        '(async()=>{assert.equal(fs.existsSync(process.env.DB_PATH),false);',
        'await db.runAsync("INSERT INTO Orders VALUES (?,?,?,?,?,?,?,?,?,?)",["CHILD","Alex","alex@example.test","Synthetic","","","","2030-01-01",100,"Authorized"]);',
        'await db.runAsync("INSERT INTO PaymentAuthorizations (OrderID,AuthorizationAmount,TransactionDateTime,AuthExpirationDate,AuthorizationResult) VALUES (?,?,?,?,?)",["CHILD",100,"2030-01-01","2030-01-02T00:00:00Z","Success"]);',
        'const result=await service.settleOrder({orderId:"CHILD",finalAmount:80},{now:()=>Date.parse("2030-01-01T12:00:00Z")});',
        'assert.equal(result.unusedAuthorizationAmount,20);await db.closeAsync();})().catch(error=>{console.error(error);process.exitCode=1;});'
    ].join('\n');
    const result = spawnSync(process.execPath, ["-e", code, path.resolve(__dirname, "../server/services/settlementService.js"), path.resolve(__dirname, "../server/database/db.js")], { env: { ...process.env, DB_PATH: f.filename }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
});


test("existing payment adapter and handler can authorize date-only expirations that Stage 6 rejects", async t => {
    const db = fixture(t).open();
    const adapterSource = fs.readFileSync(path.resolve(__dirname, "../Payment API"), "utf8");
    const serverSource = fs.readFileSync(path.resolve(__dirname, "../server/server.js"), "utf8");
    for (const [index, providerExpiration, accepted] of [
        [0, "2030-01-02", false],
        [1, undefined, false],
        [2, null, false],
        [3, "", false],
        [4, "2030-01-02T00:00:00", false],
        [5, "2030-01-02T00:00:00Z", true],
        [6, "2030-01-01T19:00:00-05:00", true]
    ]) {
        const id = "PAYMENT-EXPIRY-" + index;
        let fetchCalls = 0, paymentHandler;
        const adapter = { exports: {} };
        vm.runInNewContext(adapterSource, {
            module: adapter,
            process: { env: {} },
            AbortController, setTimeout, clearTimeout,
            console: { error() {} },
            fetch: async () => {
                fetchCalls++;
                const body = fetchCalls === 1
                    ? { access_token: "SYNTHETIC-NONSECRET", expires_in: 3600 }
                    : { Success: true, OrderId: id, AuthorizationToken: "SYNTHETIC-NONSECRET", AuthorizedAmount: 100, TokenExpirationDate: providerExpiration };
                return { status: 200, ok: true, text: async () => JSON.stringify(body) };
            }
        });
        // Execute the unchanged legacy handler with the synthetic database and
        // actual adapter above. Intercept startup, .env loading and validation;
        // no listening socket, real card, credential or network access is used.
        const app = {
            use() {}, get() {}, listen() {},
            post(route, callback) { assert.equal(route, "/api/payments"); paymentHandler = callback; }
        };
        const express = () => app;
        express.json = () => () => {};
        express.static = () => () => {};
        vm.runInNewContext(serverSource, {
            __dirname: path.resolve(__dirname, "../server"),
            process: { env: {} },
            console: { log() {}, error() {} },
            require(name) {
                if (name === "dotenv") return { config() {} };
                if (name === "express") return express;
                if (name === "cors") return () => () => {};
                if (name === "path") return path;
                if (name === "./database/db") return db;
                if (["./routes/orders", "./routes/settlements", "./routes/products"].includes(name)) return {};
                if (name === "../Payment API") return adapter.exports;
                if (name === path.resolve(__dirname, "../client/js/validation.js")) return { validateCardNumber: () => ({ valid: true }) };
                throw new Error("Unexpected legacy handler dependency: " + name);
            }
        });
        const authorized = await new Promise((resolve, reject) => {
            let status = 200;
            const res = { status(code) { status = code; return this; }, json(body) { resolve({ status, body }); } };
            Promise.resolve(paymentHandler({ body: { orderId: id, amount: 100, customer: { firstName: "Alex", email: "alex@example.test", address: "Synthetic" }, cardNumber: "SYNTHETIC-NOT-A-CARD" } }, res)).catch(reject);
        });
        assert.equal(fetchCalls, 2);
        assert.equal(authorized.status, 200);
        assert.equal(authorized.body.status, "Authorized");
        const stored = await db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations WHERE OrderID = ?", [id]);
        const expectedExpiration = [undefined, null, ""].includes(providerExpiration) ? "2028-12-31" : providerExpiration;
        assert.equal(stored.AuthExpirationDate, expectedExpiration);
        assert.equal(authorized.body.expirationDate, expectedExpiration);
        const pending = settleOrder({ orderId: id, finalAmount: 80 }, options(db));
        if (accepted) {
            assert.equal((await pending).unusedAuthorizationAmount, 20);
        } else {
            await assert.rejects(pending, error => error.code === "INVALID_EXPIRATION" && error.statusCode === 400);
            await unchanged(db, id);
        }
        assert.equal((await db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations WHERE OrderID = ?", [id])).AuthExpirationDate, stored.AuthExpirationDate);
    }
});
