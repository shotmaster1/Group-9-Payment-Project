"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture, instant } = require("./helpers/payment-fixture");
const { settleOrder } = require("../server/services/settlementService");
const { getOrderDetails, listOrders } = require("../server/services/orderQueryService");
const { createPaymentRouter } = require("../server/routes/payments");
const { createQuoteService } = require("../server/services/paymentQuoteService");
const { request } = require("./helpers/payment-fixture");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("payment prices SQLite products, snapshots items and commits actual authorization before approval", async t => {
    const f = fixture(t); const body = await f.payload("PURCHASE", [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }]);
    const response = await f.api("POST", "/", body);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, outcome: "approved", code: "PAYMENT_AUTHORIZED", status: "Authorized", message: "Payment authorized successfully.", orderId: "PURCHASE", orderTotal: 154.97, authorizedAmount: 154.97, expirationDate: "2030-01-08T12:00:00Z" });
    const detail = await getOrderDetails("PURCHASE", { database: f.db });
    assert.equal(detail.Items.length, 2); assert.equal(detail.OrderStatus, "Authorized"); assert.equal(detail.OrderTotal, 154.97);
    assert.equal(detail.LatestAuthorization.AuthorizationAmount, 154.97);
    const auth = await f.db.getAsync("SELECT * FROM PaymentAuthorizations");
    assert.equal(auth.AuthorizationToken, "SYNTHETIC-AUTH-PURCHASE"); assert.equal(auth.CardLast4, "1111"); assert.equal(auth.CardType, "visa");
    assert.doesNotMatch(JSON.stringify(response), /4111111111111111|SYNTHETIC-AUTH|authorizationToken|authToken|ccv|CVV/);
    assert.equal(f.provider.calls.find(call => !call.oauth).body.RequestedAmount, 154.97);
});

test("duplicate IDs return 409 without gateway calls or overwriting the original order", async t => {
    const f = fixture(t), body = await f.payload();
    await f.api("POST", "/", body); const before = await f.db.getAsync("SELECT * FROM Orders"); const calls = f.provider.calls.length;
    const response = await f.api("POST", "/", body);
    assert.equal(response.status, 409); assert.equal(response.body.code, "DUPLICATE_ORDER_ID"); assert.equal(response.body.outcome, "uncertain");
    assert.equal(f.provider.calls.length, calls); assert.deepEqual(await f.db.getAsync("SELECT * FROM Orders"), before);
});

test("simultaneous duplicate payments authorize only once", async t => {
    const f = fixture(t), body = await f.payload();
    const responses = await Promise.all(Array.from({ length: 6 }, () => f.api("POST", "/", body)));
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.equal(responses.filter(response => response.status === 409).length, 5);
    assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 1);
});

test("tampered browser amounts, invalid carts and payment details fail before the gateway", async t => {
    const f = fixture(t), original = await f.payload();
    const cases = [null, [], {}, { ...original, amount: 0.01 }, { ...original, total: 0.01 }, { ...original, cardNumber: "invalid" }, { ...original, ccv: "12" }, { ...original, cardMonth: 13 }, { ...original, cardYear: 35 }, { ...original, customer: { ...original.customer, zip: "invalid" } }, { ...original, customer: { ...original.customer, cardNumber: "UNSUPPORTED" } }, { ...original, items: [] }, { ...original, items: [{ productId: 999999, quantity: 1 }] }, { ...original, items: [{ productId: 1, quantity: 1, Price: 0.01 }] }, { ...original, items: [{ productId: 1, quantity: -1 }] }, { ...original, items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 1 }] }];
    for (const body of cases) {
        const response = await f.api("POST", "/", body);
        assert.equal(response.status, 400); assert.equal(response.body.success, false); assert.equal(response.body.outcome, "rejected");
    }
    assert.equal(f.provider.calls.length, 0); assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 0);
});

test("signed quotes reject forged, changed, expired, or restarted-server quotes before authorization", async t => {
    const f = fixture(t), body = await f.payload();
    for (const quoteToken of ["invalid", body.quoteToken + "x", body.quoteToken.split(".")[0] + ".AAAA", ""]) {
        const response = await f.api("POST", "/", { ...body, quoteToken });
        assert.equal(response.status, 409); assert.equal(response.body.code, "QUOTE_CHANGED");
    }
    assert.equal((await f.api("POST", "/", { ...body, items: [{ productId: 1, quantity: 1 }] })).status, 409);
    const restarted = createPaymentRouter({ database: f.db, gateway: f.gateway, quotes: createQuoteService({ key: Buffer.alloc(32, 8), now: f.now }), now: f.now });
    assert.equal((await request(restarted, "POST", "/", body)).status, 409);
    f.setTime(instant + 300000);
    assert.equal((await f.api("POST", "/", body)).status, 409);
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 0); assert.equal(f.provider.calls.length, 0);
});

test("catalog price changes trigger requoting and roll back provisional orders and items", async t => {
    const f = fixture(t), body = await f.payload();
    await f.db.runAsync("UPDATE Products SET Price=65.99 WHERE ProductID=1");
    const changed = await f.api("POST", "/", body);
    assert.equal(changed.status, 409); assert.equal(changed.body.code, "QUOTE_CHANGED");
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 0);
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0); assert.equal(f.provider.calls.length, 0);
    const confirmed = await f.api("POST", "/", await f.payload("CONFIRMED"));
    assert.equal(confirmed.body.orderTotal, 131.98); assert.equal(confirmed.status, 200);
});

test("quote expiration is checked after waiting for the order transaction lock", async t => {
    const f = fixture(t), body = await f.payload(), entered = deferred(), release = deferred();
    const held = f.db.withTransaction(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const pending = f.api("POST", "/", body); f.setTime(instant + 300000); release.resolve(); await held;
    assert.equal((await pending).status, 409); assert.equal(f.provider.calls.length, 0);
});

test("gateway calls occur outside transactions and later product changes do not rewrite order snapshots", async t => {
    let f;
    f = fixture(t, { before: async oauth => { if (!oauth) { await f.db.getAsync("SELECT 1"); await f.db.runAsync("UPDATE Products SET Price=0.01,Name='Changed' WHERE ProductID=1"); } } });
    const response = await f.api("POST", "/", await f.payload());
    assert.equal(response.status, 200); assert.equal(response.body.orderTotal, 129.98);
    const item = await f.db.getAsync("SELECT ProductName,UnitPriceCents FROM OrderItems");
    assert.deepEqual(item, { ProductName: "Trail Backpack", UnitPriceCents: 6499 });
});

test("exact-match policy preserves different actual approval amounts for review and blocks settlement", async t => {
    for (const amount of [80, 129.97, 129.99, 200]) {
        const f = fixture(t, { body: { AuthorizedAmount: amount } });
        const response = await f.api("POST", "/", await f.payload());
        assert.equal(response.status, 502); assert.equal(response.body.success, false); assert.equal(response.body.code, "AUTHORIZED_AMOUNT_MISMATCH");
        assert.match(response.body.message, /amount does not match/);
        assert.match(response.body.message, /Do not submit this payment again until its status is confirmed/);
        const detail = await getOrderDetails("SYNTHETIC-ORDER", { database: f.db });
        assert.equal(detail.OrderStatus, "Payment Review"); assert.equal(detail.OrderTotal, 129.98); assert.equal(detail.LatestAuthorization.AuthorizationAmount, amount);
        await assert.rejects(settleOrder({ orderId: "SYNTHETIC-ORDER", finalAmount: 10 }, { database: f.db, now: f.now }), { code: "ORDER_NOT_AUTHORIZED" });
    }
});

test("date-only, missing, malformed and expired approvals remain blocked without invented expiration", async t => {
    for (const expiration of ["2030-01-08", null, "", "2030-01-08T12:00:00", "2030-02-30T12:00:00Z", "2030-01-01T12:00:00Z"]) {
        const f = fixture(t, { body: { TokenExpirationDate: expiration } });
        const response = await f.api("POST", "/", await f.payload());
        assert.equal(response.body.success, false); assert.equal(response.body.outcome, "uncertain");
        assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Payment Review");
        assert.equal((await f.db.getAsync("SELECT AuthExpirationDate FROM PaymentAuthorizations")).AuthExpirationDate, expiration);
    }
});

test("invalid tokens and unusable approval amounts never produce payment success", async t => {
    for (const body of [{ AuthorizationToken: "" }, { AuthorizationToken: null }, { AuthorizationToken: {} }, { AuthorizationToken: "SYNTHETIC\nTOKEN" }, { AuthorizationToken: "\u0000" }, { AuthorizedAmount: -1 }, { AuthorizedAmount: 0 }, { AuthorizedAmount: "invalid" }, { AuthorizedAmount: "1.001" }, { AuthorizedAmount: 1e100 }]) {
        const f = fixture(t, { body });
        const response = await f.api("POST", "/", await f.payload());
        assert.equal(response.body.success, false); assert.equal(response.body.status, "Payment Review");
        assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Payment Review");
    }
});

test("mismatched or missing gateway order IDs are never attached as approvals to the requested order", async t => {
    for (const orderId of ["ANOTHER-ORDER", null]) {
        const f = fixture(t, { body: { OrderId: orderId } });
        const response = await f.api("POST", "/", await f.payload());
        assert.equal(response.status, 502); assert.equal(response.body.code, "GATEWAY_ORDER_MISMATCH");
        assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 0);
    }
});

test("declines persist zero confirmed authorization with NULL token, safe reason and Payment Failed atomically", async t => {
    const f = fixture(t, { body: { Success: false, Reason: "<script>SYNTHETIC-PRIVATE</script>" } });
    const response = await f.api("POST", "/", await f.payload());
    assert.equal(response.status, 402); assert.equal(response.body.outcome, "declined");
    const auth = await f.db.getAsync("SELECT * FROM PaymentAuthorizations");
    assert.equal(auth.AuthorizationAmount, 0); assert.equal(auth.AuthorizationToken, null); assert.equal(auth.AuthorizationResult, "Failed");
    assert.equal(auth.FailureReason, "PAYMENT_DECLINED"); assert.doesNotMatch(JSON.stringify(response), /script|SYNTHETIC-PRIVATE/);
    assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Payment Failed");
});

test("timeouts and malformed/network failures create review status without fabricating authorization records", async t => {
    for (const options of [{ network: "authorization" }, { invalidJson: true }, { status: 500 }, { timeout: "authorization" }]) {
        const f = fixture(t, options);
        const response = await f.api("POST", "/", await f.payload());
        assert.equal(response.body.outcome, "uncertain"); assert.equal(response.body.success, false);
        assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Payment Review");
        assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 0);
        assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
    }
});

test("configuration errors do not create orders or call the gateway", async t => {
    const f = fixture(t, {}, { env: {} });
    const response = await f.api("POST", "/", await f.payload());
    assert.equal(response.status, 503); assert.equal(response.body.outcome, "rejected");
    assert.equal(f.provider.calls.length, 0); assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 0);
});

test("order/item insertion failure rolls everything back before any gateway request", async t => {
    const f = fixture(t), body = await f.payload();
    await f.db.runAsync("CREATE TRIGGER RejectItem BEFORE INSERT ON OrderItems BEGIN SELECT RAISE(ABORT,'SYNTHETIC-SQL-DETAIL'); END");
    const response = await f.api("POST", "/", body);
    assert.equal(response.status, 500); assert.equal(response.body.outcome, "rejected"); assert.equal(f.provider.calls.length, 0);
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 0);
    assert.doesNotMatch(JSON.stringify(response), /SYNTHETIC-SQL-DETAIL/);
});

test("authorization insertion or status-update failure after gateway approval never returns success", async t => {
    for (const table of ["PaymentAuthorizations", "Orders"]) {
        const f = fixture(t), body = await f.payload();
        await f.db.runAsync(table === "Orders"
            ? "CREATE TRIGGER RejectWrite BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ABORT,'SYNTHETIC-SQL-DETAIL'); END"
            : "CREATE TRIGGER RejectWrite BEFORE INSERT ON PaymentAuthorizations BEGIN SELECT RAISE(ABORT,'SYNTHETIC-SQL-DETAIL'); END");
        const response = await f.api("POST", "/", body);
        assert.equal(response.status, 500); assert.equal(response.body.outcome, "uncertain");
        assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Pending");
        assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 0);
        assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 1);
        const before = f.provider.calls.length;
        assert.equal((await f.api("POST", "/", body)).status, 409); assert.equal(f.provider.calls.length, before);
    }
});

test("post-approval rollback failure quarantines the connection and returns uncertain 500", async t => {
    const f = fixture(t), body = await f.payload(), observer = f.open(); await observer.ready;
    await f.db.runAsync("CREATE TRIGGER RollbackWrite BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ROLLBACK,'synthetic rollback'); END");
    const response = await f.api("POST", "/", body);
    assert.equal(response.status, 500); assert.equal(response.body.outcome, "uncertain");
    await assert.rejects(f.db.getAsync("SELECT 1"), { code: "DB_TRANSACTION_STATE_UNKNOWN" });
    assert.equal((await observer.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Pending");
});

test("authorizations expiring while waiting for persistence are held for review", async t => {
    let f;
    f = fixture(t, { before: async oauth => { if (!oauth) f.setTime(Date.parse("2030-01-08T12:00:00Z")); } });
    const response = await f.api("POST", "/", await f.payload());
    assert.equal(response.body.code, "AUTHORIZATION_EXPIRED"); assert.equal(response.body.status, "Payment Review");
});

test("complete mocked order-to-settlement flow preserves dashboard fields and returns unused authorization", async t => {
    const f = fixture(t), payment = await f.api("POST", "/", await f.payload("FLOW"));
    assert.equal(payment.status, 200);
    const listed = await listOrders({ status: "Authorized", search: "alex@example.test" }, { database: f.db });
    assert.equal(listed.length, 1); assert.equal(listed[0].AuthorizationAmount, 129.98);
    const settled = await settleOrder({ orderId: "FLOW", finalAmount: 80 }, { database: f.db, now: f.now });
    assert.equal(settled.unusedAuthorizationAmount, 49.98);
    const detail = await getOrderDetails("FLOW", { database: f.db });
    assert.equal(detail.OrderStatus, "Settled"); assert.equal(detail.Settlements.length, 1);
    await assert.rejects(settleOrder({ orderId: "FLOW", finalAmount: 80 }, { database: f.db, now: f.now }));
});


test("ignored authorization/status writes after approval roll back and never produce payment success", async t => {
    for (const table of ["PaymentAuthorizations", "Orders"]) {
        const f = fixture(t), body = await f.payload();
        await f.db.runAsync(table === "Orders"
            ? "CREATE TRIGGER IgnoreWrite BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(IGNORE); END"
            : "CREATE TRIGGER IgnoreWrite BEFORE INSERT ON PaymentAuthorizations BEGIN SELECT RAISE(IGNORE); END");
        const response = await f.api("POST", "/", body);
        assert.equal(response.status, 500); assert.equal(response.body.success, false); assert.equal(response.body.outcome, "uncertain");
        assert.equal((await f.db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Pending");
        assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 0);
    }
});

test("duplicate requests across independent database connections still make one gateway authorization", async t => {
    const f = fixture(t), body = await f.payload(), second = f.open(); await second.ready;
    const secondRouter = createPaymentRouter({ database: second, gateway: f.gateway, quotes: f.quotes, now: f.now });
    const responses = await Promise.all([f.api("POST", "/", body), request(secondRouter, "POST", "/", body)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(f.provider.calls.filter(call => !call.oauth).length, 1);
    assert.equal((await f.db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 1);
});
