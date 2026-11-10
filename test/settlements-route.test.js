"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { createDatabase } = require("../server/database/database");
const service = require("../server/services/settlementService");
const source = fs.readFileSync(path.join(__dirname, "../server/routes/settlements.js"), "utf8");
const instant = Date.parse("2030-01-01T12:00:00Z");
const expiry = "2030-01-01T12:00:01Z";
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-settlement-route-"));
    const db = createDatabase({ filename: path.join(directory, "synthetic.sqlite") });
    t.after(async () => { await db.closeAsync(); fs.rmSync(directory, { recursive: true }); });
    return db;
}
async function seed(db, id = "SYNTHETIC", status = "Authorized", expiration = expiry) {
    await db.runAsync("INSERT INTO Orders VALUES (?, 'Alex', 'alex@example.test', 'Synthetic', '', '', '', '2030-01-01', 150, ?)", [id, status]);
    await db.runAsync("INSERT INTO PaymentAuthorizations (OrderID, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult) VALUES (?, 100, '2030-01-01', ?, 'Success')", [id, expiration]);
}
function handler(db, now = () => instant) {
    const module = { exports: {} };
    const injectedRequire = name => {
        if (name === "express") return require("express");
        if (name === "../database/db") return db;
        if (name === "../services/settlementService") return {
            SettlementError: service.SettlementError,
            settleOrder: (input, options) => service.settleOrder(input, { ...options, now })
        };
        throw new Error("Unexpected route dependency: " + name);
    };
    vm.compileFunction(source, ["require", "module"])(injectedRequire, module);
    const router = module.exports;
    return body => new Promise((resolve, reject) => {
        let status = 200;
        const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: JSON.parse(JSON.stringify(value)) }); } };
        router.handle({ method: "POST", url: "/", body }, res, error => reject(error || new Error("No route matched")));
    });
}

test("POST settlement preserves existing success fields and adds numeric unusedAuthorizationAmount", async t => {
    const db = fixture(t); await seed(db);
    const response = await handler(db)({ orderId: "SYNTHETIC", finalAmount: 80 });
    assert.deepEqual(response, { status: 200, body: { message: "Successful settlement request received", orderId: "SYNTHETIC", finalAmount: 80, authorizedAmount: 100, unusedAuthorizationAmount: 20 } });
    assert.equal(Object.hasOwn(response.body, "success"), false);
});

test("POST exact amounts succeed with zero unused funds; over-settlement retains HTTP 400 and amount fields", async t => {
    const db = fixture(t); await seed(db, "EXACT"); await seed(db, "OVER");
    const request = handler(db);
    const exact = await request({ orderId: "EXACT", finalAmount: 100 });
    assert.equal(exact.status, 200); assert.equal(exact.body.unusedAuthorizationAmount, 0);
    assert.deepEqual(await request({ orderId: "OVER", finalAmount: 120 }), { status: 400, body: { message: "Failed settlement request: Final amount ($120.00) exceeds authorized amount ($100.00).", finalAmount: 120, authorizedAmount: 100 } });
});

test("POST malformed bodies and invalid money return definite 400 rejections without writes", async t => {
    const db = fixture(t); await seed(db); const request = handler(db);
    for (const body of [undefined, null, [], {}, { orderId: " ", finalAmount: 80 }, { orderId: 123, finalAmount: 80 }, { orderId: "SYNTHETIC", finalAmount: 80, unusedAuthorizationAmount: 20 }, ...[null, "", true, 0, -1, "1.001", Infinity, "1e2", "999999999999999999999"].map(finalAmount => ({ orderId: "SYNTHETIC", finalAmount }))]) {
        const response = await request(body);
        assert.equal(response.status, 400); assert.equal(typeof response.body.message, "string");
    }
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
});

test("POST unknown order or missing authorization returns 404", async t => {
    const db = fixture(t); await seed(db); await db.runAsync("DELETE FROM PaymentAuthorizations");
    const request = handler(db);
    assert.deepEqual(await request({ orderId: "MISSING", finalAmount: 80 }), { status: 404, body: { message: "Order not found." } });
    assert.equal((await request({ orderId: "SYNTHETIC", finalAmount: 80 })).status, 404);
});

test("POST unauthorized status, latest decline and recorded history all return 400 rather than new status codes", async t => {
    const db = fixture(t); const request = handler(db);
    await seed(db, "PENDING", "Pending"); await seed(db, "DECLINED"); await seed(db, "HISTORY");
    await db.runAsync("INSERT INTO PaymentAuthorizations (OrderID,AuthorizationAmount,TransactionDateTime,AuthExpirationDate,AuthorizationResult) VALUES ('DECLINED',100,'2000-01-01',?,'Failed')", [expiry]);
    await db.runAsync("INSERT INTO Settlements VALUES (9,'HISTORY',50,'2029-01-01','Success')");
    for (const orderId of ["PENDING", "DECLINED", "HISTORY"]) assert.equal((await request({ orderId, finalAmount: 80 })).status, 400);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 1);
});

test("POST expired, date-only, missing and malformed expiration values return definite 400 rejections", async t => {
    const db = fixture(t); const request = handler(db);
    for (const [index, expiration] of ["2030-01-01T12:00:00Z", "2030-01-01", null, "invalid"].entries()) {
        const orderId = "EXP-" + index; await seed(db, orderId, "Authorized", expiration);
        assert.equal((await request({ orderId, finalAmount: 80 })).status, 400);
    }
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
});

test("simultaneous and repeated POST requests produce one 200 and remaining 400 responses", async t => {
    const db = fixture(t); await seed(db); const request = handler(db);
    const results = await Promise.all(Array.from({ length: 8 }, () => request({ orderId: "SYNTHETIC", finalAmount: 80 })));
    assert.equal(results.filter(row => row.status === 200).length, 1);
    assert.equal(results.filter(row => row.status === 400).length, 7);
    assert.equal((await request({ orderId: "SYNTHETIC", finalAmount: 80 })).status, 400);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 1);
});

test("POST status-update failure returns safe 500 and rolls back the settlement insert", async t => {
    const db = fixture(t); await seed(db);
    await db.runAsync("CREATE TRIGGER RejectStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ABORT, 'SQL_SYNTHETIC_SECRET_DETAIL'); END");
    const response = await handler(db)({ orderId: "SYNTHETIC", finalAmount: 80 });
    assert.equal(response.status, 500); assert.match(response.body.message, /Verify the order status/);
    assert.doesNotMatch(JSON.stringify(response), /SQL_SYNTHETIC_SECRET_DETAIL|SQLITE|trigger/);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
    assert.equal((await db.getAsync("SELECT OrderStatus FROM Orders")).OrderStatus, "Authorized");
});

test("POST rollback-error path returns 500 and blocks subsequent use of the uncertain connection", async t => {
    const db = fixture(t); await seed(db);
    await db.runAsync("CREATE TRIGGER RollbackStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ROLLBACK, 'synthetic rollback'); END");
    const response = await handler(db)({ orderId: "SYNTHETIC", finalAmount: 80 });
    assert.equal(response.status, 500); assert.match(response.body.message, /Verify the order status/);
    await assert.rejects(db.getAsync("SELECT 1"), { code: "DB_TRANSACTION_STATE_UNKNOWN" });
});

test("POST initialization/closed database errors never produce success or expose internal error text", async t => {
    const db = fixture(t); await db.ready; await db.closeAsync();
    const response = await handler(db)({ orderId: "SYNTHETIC", finalAmount: 80 });
    assert.equal(response.status, 500); assert.match(response.body.message, /Verify the order status/);
    assert.doesNotMatch(JSON.stringify(response), /DB_CLOSED|SQLite|filename/);
});

function warehouseUI(request) {
    const nodes = {};
    let onSubmit, fetches = 0;
    for (const name of ["settlementForm", "orderId", "finalAmount", "settlementSubmitButton", "result"]) {
        nodes[name] = { value: "", disabled: false, textContent: "", attributes: {}, focus() {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(event, callback) { if (event === "submit") onSubmit = callback; } };
    }
    const frontend = execFileSync("git", ["show", "bassel-dashboard-security:client/js/settlement.js"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    vm.runInNewContext(frontend, {
        URLSearchParams,
        window: { location: { search: "?orderId=SYNTHETIC" } },
        document: { getElementById(id) { return nodes[id]; } },
        fetch: async (url, options) => {
            fetches++; assert.equal(url, "/api/settlements");
            const response = await request(JSON.parse(options.body));
            return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body };
        }
    });
    return { nodes, fetches: () => fetches, submit: () => onSubmit({ preventDefault() {} }) };
}

test("unchanged PR 5 warehouse accepts the new success response, prefills ID and prevents double submissions", async t => {
    const db = fixture(t); await seed(db);
    const ui = warehouseUI(handler(db)); ui.nodes.finalAmount.value = "80.00";
    assert.equal(ui.nodes.orderId.value, "SYNTHETIC");
    const first = ui.submit();
    assert.equal(ui.nodes.result.textContent, "Submitting settlement...");
    assert.equal(ui.nodes.settlementSubmitButton.disabled, true);
    await Promise.all([first, ui.submit()]);
    assert.equal(ui.fetches(), 1);
    assert.equal(ui.nodes.result.textContent, "Successful settlement request received");
    assert.equal(ui.nodes.settlementSubmitButton.disabled, true);
    assert.equal(ui.nodes.orderId.disabled, true); assert.equal(ui.nodes.finalAmount.disabled, true);
    assert.equal(ui.nodes.settlementForm.attributes["aria-busy"], "false");
});

test("unchanged PR 5 warehouse allows correction after 400 and 404 without uncertain-outcome warnings", async t => {
    const db = fixture(t); await seed(db);
    const ui = warehouseUI(handler(db)); ui.nodes.finalAmount.value = "120";
    await ui.submit();
    assert.match(ui.nodes.result.textContent, /exceeds authorized amount/);
    assert.doesNotMatch(ui.nodes.result.textContent, /uncertain/);
    assert.equal(ui.nodes.settlementSubmitButton.disabled, false);
    ui.nodes.orderId.value = "MISSING"; ui.nodes.finalAmount.value = "80";
    await ui.submit(); assert.equal(ui.nodes.result.textContent, "Order not found.");
    assert.equal(ui.nodes.settlementSubmitButton.disabled, false);
    ui.nodes.orderId.value = "SYNTHETIC";
    await ui.submit(); assert.equal(ui.nodes.settlementSubmitButton.disabled, true);
});

test("unchanged PR 5 warehouse locks the form and warns after a backend 500", async t => {
    const db = fixture(t); await seed(db);
    await db.runAsync("CREATE TRIGGER RejectStatus BEFORE UPDATE OF OrderStatus ON Orders BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    const ui = warehouseUI(handler(db)); ui.nodes.finalAmount.value = "80";
    await ui.submit();
    assert.match(ui.nodes.result.textContent, /uncertain/); assert.match(ui.nodes.result.textContent, /Verify the order status/);
    assert.equal(ui.nodes.settlementSubmitButton.disabled, true);
    await ui.submit(); assert.equal(ui.fetches(), 1);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count, 0);
});
