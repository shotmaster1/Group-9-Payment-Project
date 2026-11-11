"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDatabase } = require("../server/database/database");
const { createOrderWithItems } = require("../server/services/orderService");
const { listOrders, getOrderDetails, OrderQueryError } = require("../server/services/orderQueryService");

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-order-query-"));
    const db = createDatabase({ filename: path.join(directory, "synthetic.sqlite") });
    t.after(async () => { await db.closeAsync(); fs.rmSync(directory, { recursive: true }); });
    return db;
}
async function order(db, id, { name = "Alex Example", email = "alex@example.test", total = 129.98, status = "Pending", date = "2030-01-01T00:00:00Z" } = {}) {
    await db.runAsync(`INSERT INTO Orders
        (OrderID, CustomerName, CustomerEmail, ShippingAddress, City, State, Zip, OrderDate, OrderTotal, OrderStatus)
        VALUES (?, ?, ?, '100 Synthetic Way', 'City', 'ST', '00000', ?, ?, ?)`, [id, name, email, date, total, status]);
}
async function authorization(db, id, { amount = 120, result = "Success", date = "2030-01-01T12:00:00Z", expiry = "2030-01-08", token = "SYNTHETIC-TOKEN" } = {}) {
    const saved = await db.runAsync(`INSERT INTO PaymentAuthorizations
        (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult, CardType, CardLast4, FailureReason)
        VALUES (?, ?, ?, ?, ?, ?, 'synthetic-card', '0000', ?)`, [id, token, amount, date, expiry, result, result === "Success" ? null : "Synthetic decline"]);
    return saved.lastID;
}
async function settlement(db, id, amount, result = "Success") {
    return (await db.runAsync(`INSERT INTO Settlements
        (OrderID, FinalShipmentAmount, SettlementDate, SettlementResult) VALUES (?, ?, '2030-01-02T00:00:00Z', ?)`, [id, amount, result])).lastID;
}
const createInput = id => ({ orderId: id, customer: { firstName: "Alex", lastName: "Example", email: "alex@example.test", address: "100 Synthetic Way", city: "City", state: "ST", zip: "00000" }, items: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }] });

test("collection returns an empty array for an empty synthetic database", async t => {
    const db = fixture(t);
    assert.deepEqual(await listOrders({}, { database: db }), []);
});

test("collection returns each order once and picks highest authorization ID, not timestamp or success", async t => {
    const db = fixture(t);
    await order(db, "A", { status: "Authorized" });
    await order(db, "B");
    await order(db, "C");
    await authorization(db, "A", { amount: 129.98, date: "2099-01-01T00:00:00Z" });
    await authorization(db, "B", { amount: 11 });
    const latest = await authorization(db, "A", { amount: 75, result: "Declined", date: "2020-01-01T00:00:00Z", expiry: "2030-02-01T10:00:00Z", token: null });
    const rows = await listOrders({}, { database: db });
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map(row => row.OrderID)).size, 3);
    const a = rows.find(row => row.OrderID === "A");
    assert.equal(a.OrderStatus, "Authorized"); // Stored status, not inferred from the authorization.
    assert.equal(a.OrderTotal, 129.98);
    assert.equal(a.AuthorizationAmount, 75);
    assert.equal(a.AuthorizationResult, "Declined");
    assert.equal(a.TransactionDateTime, "2020-01-01T00:00:00Z");
    assert.equal(a.AuthExpirationDate, "2030-02-01T10:00:00Z");
    assert.equal(a.HasAuthorizationToken, false);
    assert.equal(rows.find(row => row.OrderID === "B").HasAuthorizationToken, true);
    assert.ok(rows.every(row => !Object.hasOwn(row, "AuthorizationToken") && !Object.hasOwn(row, "FailureReason")));
    assert.equal((await db.getAsync("SELECT MAX(AuthorizationID) AS id FROM PaymentAuthorizations WHERE OrderID='A'")).id, latest);
    const c = rows.find(row => row.OrderID === "C");
    assert.equal(c.HasAuthorizationToken, false);
    for (const field of ["AuthorizationAmount", "TransactionDateTime", "AuthExpirationDate", "AuthorizationResult", "CardType", "CardLast4"]) assert.equal(c[field], null);
});

test("collection preserves ID, email and customer-name search with status and all sort modes", async t => {
    const db = fixture(t);
    await order(db, "ALPHA", { name: "Alice Example", email: "first@example.test", total: 30, date: "2030-01-01", status: "Authorized" });
    await order(db, "BETA", { name: "Bob Example", email: "alice@example.test", total: 10, date: "2030-01-03" });
    await order(db, "GAMMA", { name: "Alice Other", email: "other@example.test", total: 20, date: "2030-01-02", status: "Authorized" });
    for (let i = 0; i < 3; i++) await authorization(db, "ALPHA", { date: "2099-01-01" });
    const ids = async filters => (await listOrders(filters, { database: db })).map(row => row.OrderID);
    assert.deepEqual(await ids({ search: "alp" }), ["ALPHA"]);
    assert.deepEqual(await ids({ search: "FIRST@EXAMPLE.TEST" }), ["ALPHA"]);
    assert.deepEqual(await ids({ search: "Alice", sort: "oldest" }), ["ALPHA", "GAMMA", "BETA"]);
    assert.deepEqual(await ids({ search: "Alice", status: "Authorized", sort: "newest" }), ["GAMMA", "ALPHA"]);
    assert.deepEqual(await ids({ status: "Pending" }), ["BETA"]);
    assert.deepEqual(await ids({ sort: "amount_asc" }), ["BETA", "GAMMA", "ALPHA"]);
    assert.deepEqual(await ids({ sort: "amount_desc" }), ["ALPHA", "GAMMA", "BETA"]);
    assert.deepEqual(await ids({ status: "", search: "", sort: "" }), ["BETA", "GAMMA", "ALPHA"]);
    assert.deepEqual(await ids({ sort: "unknown" }), ["BETA", "GAMMA", "ALPHA"]);
    assert.deepEqual(await ids({ sort: "__proto__" }), ["BETA", "GAMMA", "ALPHA"]);
    assert.deepEqual(await ids({ search: "no match" }), []);
});

test("collection sort ties are deterministic by OrderID and sorting remains by order date", async t => {
    const db = fixture(t);
    await order(db, "B"); await order(db, "A");
    await authorization(db, "B", { date: "2099-12-31" });
    for (const sort of ["newest", "oldest", "amount_asc", "amount_desc"]) {
        assert.deepEqual((await listOrders({ sort }, { database: db })).map(row => row.OrderID), ["A", "B"]);
    }
});

test("collection binds search/status and allowlists sort expressions", async t => {
    const db = fixture(t);
    const id = "literal' OR 1=1 --";
    await order(db, id); await order(db, "unrelated");
    assert.deepEqual((await listOrders({ search: id }, { database: db })).map(row => row.OrderID), [id]);
    assert.deepEqual(await listOrders({ status: "Pending' OR 1=1 --" }, { database: db }), []);
    assert.equal((await listOrders({ sort: "OrderID; DROP TABLE Orders" }, { database: db })).length, 2);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 2);
});

test("details return original total and saved item snapshots rather than current product values", async t => {
    const db = fixture(t);
    const created = await createOrderWithItems(createInput("SNAPSHOT"), { database: db });
    await db.runAsync("UPDATE Products SET Name='Changed later', Price=0.01 WHERE ProductID IN (1,2)");
    const detail = await getOrderDetails("SNAPSHOT", { database: db });
    assert.equal(detail.OrderID, "SNAPSHOT");
    assert.equal(detail.OrderStatus, "Pending");
    assert.equal(detail.CustomerName, "Alex Example");
    assert.equal(detail.CustomerEmail, "alex@example.test");
    assert.equal(detail.ShippingAddress, "100 Synthetic Way");
    assert.equal(detail.City, "City"); assert.equal(detail.State, "ST"); assert.equal(detail.Zip, "00000");
    assert.equal(detail.OrderDate, created.orderDate);
    assert.equal(detail.OrderTotal, 154.97);
    assert.deepEqual(detail.Items.map(({ ProductID, ProductName, UnitPriceCents, Quantity }) => ({ ProductID, ProductName, UnitPriceCents, Quantity })), [
        { ProductID: 1, ProductName: "Trail Backpack", UnitPriceCents: 6499, Quantity: 2 },
        { ProductID: 2, ProductName: "Insulated Bottle", UnitPriceCents: 2499, Quantity: 1 }
    ]);
    assert.ok(detail.Items[0].OrderItemID < detail.Items[1].OrderItemID);
    assert.equal(detail.LatestAuthorization, null);
    assert.deepEqual(detail.Settlements, []);
});

test("historical orders remain itemless and keep their original totals and recorded settlement history", async t => {
    const db = fixture(t);
    await order(db, "HISTORICAL", { total: 321.45, status: "Settled" });
    await authorization(db, "HISTORICAL", { amount: 300 });
    await settlement(db, "HISTORICAL", 250);
    const detail = await getOrderDetails("HISTORICAL", { database: db });
    assert.deepEqual(detail.Items, []);
    assert.equal(detail.OrderTotal, 321.45);
    assert.equal(detail.OrderStatus, "Settled");
    assert.equal(detail.LatestAuthorization.AuthorizationAmount, 300);
    assert.equal(detail.Settlements[0].FinalShipmentAmount, 250);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0);
});

test("details select latest authorization with its actual stored amount and UTC expiration", async t => {
    const db = fixture(t);
    await order(db, "LATEST", { total: 999 });
    await authorization(db, "LATEST", { amount: 999, date: "2099-01-01", expiry: "2099-01-08" });
    const id = await authorization(db, "LATEST", { amount: 87.65, date: "2020-01-01T10:20:30Z", expiry: "2030-02-03T12:30:00-05:00" });
    assert.deepEqual((await getOrderDetails("LATEST", { database: db })).LatestAuthorization, {
        AuthorizationID: id, AuthorizationAmount: 87.65, TransactionDateTime: "2020-01-01T10:20:30Z",
        AuthExpirationDate: "2030-02-03T17:30:00Z", AuthorizationResult: "Success"
    });
});

test("latest declined authorization is not replaced with an older approval, and nullable fields are retained", async t => {
    const db = fixture(t);
    await order(db, "DECLINED");
    await authorization(db, "DECLINED");
    const id = await authorization(db, "DECLINED", { result: "Declined", amount: 40, expiry: null, token: null });
    const auth = (await getOrderDetails("DECLINED", { database: db })).LatestAuthorization;
    assert.equal(auth.AuthorizationID, id);
    assert.equal(auth.AuthorizationResult, "Declined");
    assert.equal(auth.AuthorizationAmount, 40);
    assert.equal(auth.AuthExpirationDate, null);
    assert.equal(Object.hasOwn(auth, "AuthorizationToken"), false);
});

test("details retain all historical duplicate settlements in descending SettlementID order", async t => {
    const db = fixture(t);
    await order(db, "DUPLICATE-SETTLEMENTS");
    const first = await settlement(db, "DUPLICATE-SETTLEMENTS", 50);
    const second = await settlement(db, "DUPLICATE-SETTLEMENTS", 50);
    const third = await settlement(db, "DUPLICATE-SETTLEMENTS", 60, "Rejected");
    const rows = (await getOrderDetails("DUPLICATE-SETTLEMENTS", { database: db })).Settlements;
    assert.deepEqual(rows.map(row => row.SettlementID), [third, second, first]);
    assert.deepEqual(rows.map(row => row.SettlementResult), ["Rejected", "Success", "Success"]);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 3);
});

test("detail lookups bind exact IDs and never mix related records from other orders", async t => {
    const db = fixture(t);
    const id = "literal'/path? OR 1=1 --";
    await createOrderWithItems(createInput(id), { database: db });
    await order(db, "OTHER");
    await authorization(db, "OTHER", { amount: 1 }); await settlement(db, "OTHER", 1);
    const detail = await getOrderDetails(id, { database: db });
    assert.equal(detail.OrderID, id);
    assert.equal(detail.Items.length, 2);
    assert.ok(detail.Items.every(item => item.OrderID === id));
    assert.equal(detail.LatestAuthorization, null);
    assert.deepEqual(detail.Settlements, []);
    assert.equal(await getOrderDetails("' OR 1=1 --", { database: db }), null);
});

test("new detail response allowlists fields even when synthetic tables contain sensitive extra columns", async t => {
    const db = fixture(t);
    await createOrderWithItems(createInput("SAFE"), { database: db });
    await authorization(db, "SAFE", { token: "SYNTHETIC-SECRET-TOKEN" });
    await settlement(db, "SAFE", 100);
    for (const table of ["Orders", "OrderItems", "PaymentAuthorizations", "Settlements"]) {
        await db.runAsync(`ALTER TABLE ${table} ADD COLUMN CardNumber TEXT`);
        await db.runAsync(`ALTER TABLE ${table} ADD COLUMN CVV TEXT`);
        await db.runAsync(`UPDATE ${table} SET CardNumber='SYNTHETIC-PAN-DO-NOT-RETURN', CVV='SYNTHETIC-CVV-DO-NOT-RETURN'`);
    }
    await db.runAsync("UPDATE PaymentAuthorizations SET CardLast4='SYNTHETIC-FULL-PAN', FailureReason='SYNTHETIC-SECRET-TOKEN'");
    const detail = await getOrderDetails("SAFE", { database: db });
    assert.deepEqual(Object.keys(detail).sort(), ["OrderID", "CustomerName", "CustomerEmail", "ShippingAddress", "City", "State", "Zip", "OrderDate", "OrderTotal", "OrderStatus", "Items", "LatestAuthorization", "Settlements"].sort());
    assert.deepEqual(Object.keys(detail.Items[0]).sort(), ["OrderItemID", "OrderID", "ProductID", "ProductName", "UnitPriceCents", "Quantity"].sort());
    assert.deepEqual(Object.keys(detail.LatestAuthorization).sort(), ["AuthorizationID", "AuthorizationAmount", "TransactionDateTime", "AuthExpirationDate", "AuthorizationResult"].sort());
    assert.deepEqual(Object.keys(detail.Settlements[0]).sort(), ["SettlementID", "OrderID", "FinalShipmentAmount", "SettlementDate", "SettlementResult"].sort());
    assert.doesNotMatch(JSON.stringify(detail), /SYNTHETIC-(?:SECRET|PAN|CVV|FULL-PAN)|AuthorizationToken|CardNumber|CardLast4|CardType|FailureReason|CVV/);
});

test("invalid or blank detail IDs are rejected before any database use", async () => {
    const database = { withTransaction() { throw new Error("Must not touch a database"); } };
    for (const id of [undefined, null, "", " \t\n", 123, [], {}, true]) {
        await assert.rejects(getOrderDetails(id, { database }), error => error instanceof OrderQueryError && error.statusCode === 400);
    }
});

test("malformed collection query parameters are rejected before any database use", async () => {
    const database = { allAsync() { throw new Error("Must not touch a database"); } };
    for (const filters of [null, [], "text", { status: [] }, { search: {} }, { sort: null }, { search: 12 }]) {
        await assert.rejects(listOrders(filters, { database }), error => error instanceof OrderQueryError && error.statusCode === 400);
    }
});

test("details read order, items, authorization and settlements through exactly one managed transaction", async t => {
    const db = fixture(t);
    await order(db, "SCOPE");
    let calls = 0; const statements = [];
    const database = {
        withTransaction(work) {
            calls++;
            return db.withTransaction(tx => work({
                get(sql, params) { statements.push(sql); return tx.get(sql, params); },
                all(sql, params) { statements.push(sql); return tx.all(sql, params); }
            }));
        }
    };
    const detail = await getOrderDetails("SCOPE", { database });
    assert.equal(detail.OrderID, "SCOPE"); assert.equal(calls, 1); assert.equal(statements.length, 4);
    assert.ok(statements.every(sql => /^\s*SELECT\b/.test(sql)));
    statements.length = 0;
    assert.equal(await getOrderDetails("MISSING", { database }), null);
    assert.equal(statements.length, 1);
});

test("queries do not change any order, product, authorization, item or settlement records", async t => {
    const db = fixture(t);
    await createOrderWithItems(createInput("READ-ONLY"), { database: db });
    await authorization(db, "READ-ONLY"); await authorization(db, "READ-ONLY", { result: "Declined" });
    await settlement(db, "READ-ONLY", 10); await settlement(db, "READ-ONLY", 10);
    const snapshot = async () => {
        const rows = {};
        for (const table of ["Orders", "Products", "OrderItems", "PaymentAuthorizations", "Settlements"]) rows[table] = await db.allAsync(`SELECT * FROM ${table} ORDER BY rowid`);
        return rows;
    };
    const before = await snapshot();
    await listOrders({}, { database: db }); await getOrderDetails("READ-ONLY", { database: db });
    assert.deepEqual(await snapshot(), before);
});

test("query database failures propagate and a closed synthetic database is never replaced with the default", async t => {
    const db = fixture(t);
    await db.ready; await db.closeAsync();
    await assert.rejects(listOrders({}, { database: db }), { code: "DB_CLOSED" });
    await assert.rejects(getOrderDetails("ANY", { database: db }), { code: "DB_CLOSED" });
});
