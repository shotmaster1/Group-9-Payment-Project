"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const sqlite3 = require("sqlite3");
const central = require("../server/database/database");
const { createDatabase } = central;
const schema = fs.readFileSync(path.join(__dirname, "../server/database/schema.sql"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-stage1-"));
    const filename = path.join(directory, "synthetic.sqlite");
    const connections = [];
    t.after(async () => {
        await Promise.all(connections.map((db) => db.closeAsync()));
        fs.rmSync(directory, { recursive: true });
    });
    return {
        directory, filename,
        open() {
            const db = createDatabase({ filename });
            connections.push(db);
            return db;
        },
    };
}
async function ledger(db) {
    await db.runAsync("CREATE TABLE TestLedger (ID INTEGER PRIMARY KEY, Value TEXT NOT NULL UNIQUE)");
}
function nativeExec(filename, sql) {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(filename, (openError) => {
            if (openError) return reject(openError);
            connection.exec(sql, (error) => {
                connection.close((closeError) => error || closeError ? reject(error || closeError) : resolve());
            });
        });
    });
}

test("imports and unused close are lazy; db.js is the exact central export", (t) => {
    const f = fixture(t);
    const code = [
        'const assert = require("node:assert/strict");',
        'const fs = require("node:fs");',
        'const central = require(process.argv[1]);',
        'const legacy = require(process.argv[2]);',
        'assert.equal(central, legacy);',
        'assert.equal(central.filename, process.env.DB_PATH);',
        'assert.equal(fs.existsSync(process.env.DB_PATH), false);',
        'central.closeAsync().then(() => assert.equal(fs.existsSync(process.env.DB_PATH), false));',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", code,
        path.resolve(__dirname, "../server/database/database.js"),
        path.resolve(__dirname, "../server/database/db.js")], {
        env: { ...process.env, DB_PATH: f.filename }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.filename), false);
    assert.equal(require("../server/database/db"), central);
});

test("DB_PATH selects an isolated default database with legacy chaining and Promise helpers", (t) => {
    const f = fixture(t);
    const code = [
        'const assert = require("node:assert/strict");',
        'const db = require(process.argv[1]);',
        '(async () => {',
        '  assert.equal(db.filename, process.env.DB_PATH);',
        '  await db.ready;',
        '  assert.equal(db.run("CREATE TABLE Compatibility (ID INTEGER PRIMARY KEY, Value TEXT)"), db);',
        '  await new Promise((resolve, reject) => db.run("INSERT INTO Compatibility(Value) VALUES (?)", ["synthetic"], function(error) {',
        '    if (error) return reject(error); assert.equal(this.lastID, 1); assert.equal(this.changes, 1); resolve();',
        '  }));',
        '  assert.equal((await db.getAsync("SELECT Value FROM Compatibility")).Value, "synthetic");',
        '  await db.closeAsync();',
        '})().catch(error => { console.error(error); process.exitCode = 1; });',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", code, path.resolve(__dirname, "../server/database/db.js")], {
        env: { ...process.env, DB_PATH: f.filename }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.filename), true);
});

test("fresh initialization queues reads, enables foreign keys, and creates the versioned schema", async (t) => {
    const db = fixture(t).open();
    const count = await db.getAsync("SELECT COUNT(*) AS count FROM Products");
    assert.equal(count.count, 5);
    assert.equal((await db.getAsync("PRAGMA foreign_keys")).foreign_keys, 1);
    assert.equal((await db.getAsync("PRAGMA user_version")).user_version, 2);
    const tables = await db.allAsync("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    assert.deepEqual(tables.map((row) => row.name), ["OrderItems", "Orders", "PaymentAuthorizations", "Products", "Settlements"]);
    assert.equal(await db.getAsync("SELECT * FROM Products WHERE ProductID = -1"), undefined);
});

test("reopening preserves existing products instead of reseeding or rewriting prices/images", async (t) => {
    const f = fixture(t);
    const first = f.open();
    await first.runAsync("UPDATE Products SET Price = ?, ImageURL = ? WHERE ProductID = ?", [12.34, "/synthetic.png", 1]);
    const before = await first.allAsync("SELECT * FROM Products ORDER BY ProductID");
    await first.closeAsync();
    const second = f.open();
    assert.deepEqual(await second.allAsync("SELECT * FROM Products ORDER BY ProductID"), before);
});

test("Promise and callback APIs support context, binding forms, chaining, and nested callbacks", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    await new Promise((resolve, reject) => {
        assert.equal(db.run("INSERT INTO TestLedger VALUES (?, ?)", 1, "one", function (error) {
            if (error) return reject(error);
            assert.equal(this.lastID, 1);
            assert.equal(this.changes, 1);
            assert.equal(db.get("SELECT Value FROM TestLedger WHERE ID = $id", { $id: 1 }, (getError, row) => {
                if (getError) return reject(getError);
                assert.equal(row.Value, "one");
                assert.equal(db.all("SELECT * FROM TestLedger", (allError, rows) => {
                    if (allError) return reject(allError);
                    assert.equal(rows.length, 1);
                    resolve();
                }), db);
            }), db);
        }), db);
    });
    const result = await db.runAsync("UPDATE TestLedger SET Value = ? WHERE ID = ?", ["updated", 1]);
    assert.equal(result.changes, 1);
    let calls = 0;
    await new Promise((resolve) => db.run("INSERT INTO MissingTable VALUES (1)", (error) => {
        calls++;
        assert.equal(error.code, "SQLITE_ERROR");
        resolve();
    }));
    await flush();
    assert.equal(calls, 1);
    assert.equal((await db.getAsync("SELECT Value FROM TestLedger")).Value, "updated");
});

test("callbackless operations execute; their errors are handled without poisoning the queue", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    db.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "fire-and-forget"]);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM TestLedger")).count, 1);
    const errorEvent = new Promise((resolve) => db.once("error", resolve));
    db.run("INSERT INTO MissingTable VALUES (1)");
    assert.equal((await errorEvent).code, "SQLITE_ERROR");
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM TestLedger")).count, 1);
});

test("successful transactions commit all work and return the callback result", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    const returned = await db.withTransaction(async (tx) => {
        const inserted = await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "one"]);
        assert.equal(inserted.lastID, 1);
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [2, "two"]);
        assert.equal((await tx.all("SELECT * FROM TestLedger")).length, 2);
        return (await tx.get("SELECT Value FROM TestLedger WHERE ID = ?", [2])).Value;
    });
    assert.equal(returned, "two");
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM TestLedger")).count, 2);
});

test("exceptions and SQLite constraint failures roll back all writes; later work recovers", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    await assert.rejects(db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "rolled-back"]);
        throw new Error("synthetic failure");
    }), /synthetic failure/);
    await assert.rejects(db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "one"]);
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [2, "one"]);
    }), { code: "SQLITE_CONSTRAINT" });
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM TestLedger")).count, 0);
    await db.runAsync("INSERT INTO TestLedger VALUES (?, ?)", [3, "recovered"]);
    assert.equal((await db.getAsync("SELECT Value FROM TestLedger")).Value, "recovered");
});

test("unawaited transaction query failures still prevent a partial commit", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    await assert.rejects(db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "one"]);
        tx.run("INSERT INTO TestLedger VALUES (?, ?)", [2, "one"]);
    }), { code: "SQLITE_CONSTRAINT" });
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM TestLedger")).count, 0);
});

test("foreign-key enforcement rolls back a transaction with an orphaned authorization", async (t) => {
    const db = fixture(t).open();
    await assert.rejects(db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO Products(Name,Price) VALUES (?, ?)", ["Synthetic product", 1]);
        await tx.run("INSERT INTO PaymentAuthorizations(OrderID,AuthorizationAmount,TransactionDateTime,AuthorizationResult) VALUES (?, ?, ?, ?)", ["NONEXISTENT", 1, "2030-01-01T00:00:00Z", "Failed"]);
    }), { code: "SQLITE_CONSTRAINT" });
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Products")).count, 5);
});

test("concurrent read-modify-write transactions serialize without losing updates", async (t) => {
    const db = fixture(t).open();
    await db.runAsync("CREATE TABLE TestCounter (Value INTEGER NOT NULL)");
    await db.runAsync("INSERT INTO TestCounter VALUES (0)");
    await Promise.all(Array.from({ length: 20 }, () => db.withTransaction(async (tx) => {
        const row = await tx.get("SELECT Value FROM TestCounter");
        await flush();
        await tx.run("UPDATE TestCounter SET Value = ?", [row.Value + 1]);
    })));
    assert.equal((await db.getAsync("SELECT Value FROM TestCounter")).Value, 20);
});

test("unrelated legacy writes wait outside a paused transaction and survive its rollback", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    const entered = deferred();
    const release = deferred();
    const transaction = db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "rollback"]);
        entered.resolve();
        await release.promise;
        throw new Error("rollback this transaction only");
    });
    const rejected = assert.rejects(transaction, /rollback this transaction only/);
    await entered.promise;
    let legacyFinished = false;
    const legacy = new Promise((resolve, reject) => db.run("INSERT INTO TestLedger VALUES (?, ?)", [2, "outside"], (error) => {
        legacyFinished = true;
        error ? reject(error) : resolve();
    }));
    await flush();
    assert.equal(legacyFinished, false);
    release.resolve();
    await rejected;
    await legacy;
    assert.deepEqual(await db.allAsync("SELECT * FROM TestLedger"), [{ ID: 2, Value: "outside" }]);
});

test("separate connections coordinate write transactions through SQLite locks", async (t) => {
    const f = fixture(t);
    const first = f.open();
    const second = f.open();
    await Promise.all([first.ready, second.ready]);
    await ledger(first);
    const entered = deferred();
    const transaction = first.withTransaction(async (tx) => {
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "first"]);
        entered.resolve();
        await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await entered.promise;
    const concurrent = second.withTransaction((tx) => tx.run("INSERT INTO TestLedger VALUES (?, ?)", [2, "second"]));
    await Promise.all([transaction, concurrent]);
    assert.equal((await second.getAsync("SELECT COUNT(*) AS count FROM TestLedger")).count, 2);
});

test("public helpers/nested transactions reject inside a transaction; scoped helpers expire", async (t) => {
    const db = fixture(t).open();
    let savedTx;
    await db.withTransaction(async (tx) => {
        savedTx = tx;
        await assert.rejects(db.getAsync("SELECT 1"), { code: "DB_TRANSACTION_CONTEXT" });
        await assert.rejects(db.withTransaction(() => {}), { code: "DB_TRANSACTION_CONTEXT" });
        await assert.rejects(db.closeAsync(), { code: "DB_TRANSACTION_CONTEXT" });
        await new Promise((resolve) => db.get("SELECT 1", (error) => {
            assert.equal(error.code, "DB_TRANSACTION_CONTEXT"); resolve();
        }));
        assert.equal((await tx.get("SELECT 1 AS value")).value, 1);
    });
    await assert.rejects(savedTx.get("SELECT 1"), { code: "DB_TRANSACTION_CLOSED" });
    await assert.rejects(db.runAsync("-- deliberate misuse\nBEGIN"), { code: "DB_TRANSACTION_CONTROL" });
});

test("legacy initialization preserves historical values while adding the Stage 2 schema", async (t) => {
    const f = fixture(t);
    const legacySchema = schema.slice(0, schema.indexOf("-- Snapshot values"))
        .replace("    AuthorizationToken TEXT,", "    AuthorizationToken TEXT NOT NULL,")
        .replace("    FailureReason TEXT,\n", "");
    await nativeExec(f.filename, legacySchema + [
        "INSERT INTO Products(ProductID,Name,Price,ImageURL) VALUES (7,'Synthetic legacy product',1.23,'/legacy.png');",
        "INSERT INTO Orders VALUES ('SYNTHETIC','Example','example@example.test','Synthetic','City','ST','00000','2030-01-01',1.23,'Authorized');",
        "INSERT INTO PaymentAuthorizations VALUES (17,'SYNTHETIC','synthetic-reference',1.23,'2030-01-01','2030-12-31','Success','visa','0000');",
        "INSERT INTO Settlements VALUES (9,'SYNTHETIC',1.23,'2030-01-01','Success');",
    ].join("\n"));
    const db = f.open();
    assert.deepEqual((await db.ready).appliedVersions, [1, 2]);
    assert.equal((await db.getAsync("SELECT * FROM Products WHERE ProductID = 7")).ImageURL, "/legacy.png");
    assert.deepEqual(await db.getAsync("SELECT AuthorizationID, OrderID, AuthorizationToken, FailureReason FROM PaymentAuthorizations"), {
        AuthorizationID: 17, OrderID: "SYNTHETIC", AuthorizationToken: "synthetic-reference", FailureReason: null,
    });
    assert.equal((await db.getAsync("SELECT SettlementID FROM Settlements")).SettlementID, 9);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0);
});

test("open errors reject readiness and subsequent operations without creating a fixture database", async (t) => {
    const f = fixture(t);
    const missing = path.join(f.directory, "missing-parent", "synthetic.sqlite");
    const db = createDatabase({ filename: missing });
    await assert.rejects(db.ready, { code: "SQLITE_CANTOPEN" });
    await assert.rejects(db.getAsync("SELECT 1"), { code: "SQLITE_CANTOPEN" });
    await db.closeAsync();
    assert.equal(fs.existsSync(missing), false);
    assert.throws(() => createDatabase(), /explicit filename/);
});

test("close drains accepted work, blocks new operations, and is idempotent", async (t) => {
    const db = fixture(t).open();
    await ledger(db);
    const entered = deferred();
    const release = deferred();
    const pending = db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO TestLedger VALUES (?, ?)", [1, "one"]);
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    const closing = db.closeAsync();
    assert.equal(db.closeAsync(), closing);
    await assert.rejects(db.getAsync("SELECT 1"), { code: "DB_CLOSED" });
    release.resolve();
    await pending;
    await closing;
    await db.closeAsync();
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
});


test("transaction-control SQL cannot bypass the queue with comments or empty statements", async (t) => {
    const db = fixture(t).open();
    for (const sql of ["; BEGIN IMMEDIATE", ";; /* comment */ BEGIN", "-- comment\n; COMMIT", "; END", "; ROLLBACK", "; SAVEPOINT x", "; RELEASE x"]) {
        await assert.rejects(db.runAsync(sql), { code: "DB_TRANSACTION_CONTROL" });
    }
    assert.equal(await db.withTransaction(async (tx) => (await tx.get("SELECT 1 AS value")).value), 1);
});

test("schema and seed initialization roll back together on a synthetic seed constraint failure", async (t) => {
    const f = fixture(t);
    await nativeExec(f.filename, "CREATE TABLE Products (ProductID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT NOT NULL CHECK(Name <> 'Trail Cap'), Description TEXT, Price REAL NOT NULL, ImageURL TEXT)");
    const before = fs.readFileSync(f.filename);
    const db = f.open();
    await assert.rejects(db.ready, { code: "SQLITE_CONSTRAINT" });
    await db.closeAsync();
    assert.deepEqual(fs.readFileSync(f.filename), before, "No new tables or partial seed rows survive initialization failure");
});
