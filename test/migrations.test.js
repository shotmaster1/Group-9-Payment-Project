"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sqlite3 = require("sqlite3");
const { createDatabase } = require("../server/database/database");
const { CURRENT_SCHEMA_VERSION, migrateDatabase } = require("../server/database/migrations");
const schema = fs.readFileSync(path.join(__dirname, "../server/database/schema.sql"), "utf8");
const baseSchema = schema.slice(0, schema.indexOf("-- Snapshot values"));
const itemSchema = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS OrderItems"));
const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
const digest = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "group9-stage2-"));
    const filename = path.join(directory, "synthetic.sqlite");
    const connections = [];
    t.after(async () => {
        await Promise.all(connections.map((db) => db.closeAsync()));
        fs.rmSync(directory, { recursive: true });
    });
    return { filename, open() { const db = createDatabase({ filename }); connections.push(db); return db; } };
}
async function withRaw(filename, work) {
    let connection;
    await new Promise((resolve, reject) => {
        connection = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve());
    });
    const db = {
        run(sql, params = []) { return new Promise((resolve, reject) => connection.run(sql, params, function (error) {
            error ? reject(error) : resolve({ lastID: this.lastID, changes: this.changes });
        })); },
        get(sql, params = []) { return new Promise((resolve, reject) => connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row))); },
        all(sql, params = []) { return new Promise((resolve, reject) => connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))); },
        exec(sql) { return new Promise((resolve, reject) => connection.exec(sql, (error) => error ? reject(error) : resolve())); },
    };
    try { await db.run("PRAGMA foreign_keys = ON"); return await work(db); }
    finally { await new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve())); }
}
async function snapshot(db) {
    const objects = await db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
    const rows = {};
    for (const item of objects.filter((entry) => entry.type === "table")) {
        rows[item.name] = await db.all("SELECT * FROM " + quote(item.name) + " ORDER BY rowid");
    }
    return { objects, rows, version: (await db.get("PRAGMA user_version")).user_version };
}
async function legacy(filename, options = {}) {
    const name = options.tableName || "PaymentAuthorizations";
    const token = options.tokenNullable ? "AuthorizationToken TEXT," :
        options.quotedToken ? '"AuthorizationToken" TEXT CONSTRAINT token_required NOT NULL ON CONFLICT ABORT,' : "AuthorizationToken TEXT NOT NULL,";
    let sql = baseSchema.replace("AuthorizationToken TEXT,", token);
    if (!options.failureReason) sql = sql.replace("    FailureReason TEXT,\n", "");
    sql = sql.replace("    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE CASCADE", "    ProviderTrace TEXT DEFAULT 'AuthorizationToken TEXT NOT NULL is only a literal',\n    UNIQUE(OrderID, TransactionDateTime),\n    CHECK(AuthorizationAmount >= 0),\n    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE CASCADE");
    if (options.tokenCheck) sql = sql.replace("CHECK(AuthorizationAmount >= 0)", "CHECK(AuthorizationAmount >= 0), CHECK(AuthorizationToken IS NOT NULL)");
    sql = sql.replaceAll("PaymentAuthorizations", name);
    await withRaw(filename, async (db) => {
        await db.exec(sql);
        for (let i = 1; i <= 5; i++) {
            await db.run("INSERT INTO Products(ProductID,Name,Description,Price,ImageURL) VALUES (?, ?, ?, ?, ?)", [i, "Synthetic product " + i, "Synthetic description", 10 + i + 0.25, "/synthetic/p" + i + ".png"]);
        }
        for (let i = 1; i <= 16; i++) {
            const id = "SYN-ORDER-" + String(i).padStart(2, "0");
            const status = i <= 3 ? "Authorized" : i % 2 ? "Payment Failed" : "Pending";
            await db.run("INSERT INTO Orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, "Synthetic Person " + i, "synthetic" + i + "@example.test", "Synthetic address", "City", "ST", "00000", "2030-01-01T00:00:00Z", i * 1.25, status]);
        }
        for (let i = 1; i <= 18; i++) {
            const order = i <= 16 ? i : i - 16;
            const id = "SYN-ORDER-" + String(order).padStart(2, "0");
            await db.run("INSERT INTO " + quote(name) + " (AuthorizationID,OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthExpirationDate,AuthorizationResult,CardType,CardLast4,ProviderTrace) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [i * 10, id, "synthetic-reference-" + i, i * 1.25, "2030-01-01T00:00:" + String(i).padStart(2, "0") + "Z", "2030-12-31", i % 2 ? "Success" : "Failed", "visa", "0000", "synthetic-trace-" + i]);
        }
        if (options.failureReason) await db.run("UPDATE " + quote(name) + " SET FailureReason = ? WHERE AuthorizationID = ?", ["Preserve synthetic failure detail", 20]);
        for (let i = 1; i <= 9; i++) {
            const order = ((i - 1) % 3) + 1;
            await db.run("INSERT INTO Settlements VALUES (?, ?, ?, ?, ?)", [i * 10, "SYN-ORDER-0" + order, i * 0.25, "2030-01-02T00:00:00Z", "Success"]);
        }
        // Reserve deleted-ID high-water marks without retaining extra records.
        await db.run("UPDATE sqlite_sequence SET seq = 900 WHERE name = ?", [name]);
        await db.run("UPDATE sqlite_sequence SET seq = 700 WHERE name = 'Settlements'");
        await db.exec("CREATE TABLE SyntheticAudit (AuditID INTEGER PRIMARY KEY AUTOINCREMENT, AuthorizationID INTEGER NOT NULL);" +
            "CREATE INDEX SyntheticAuthByOrder ON " + quote(name) + " (OrderID);" +
            "CREATE TRIGGER SyntheticAuthAudit AFTER INSERT ON " + quote(name) + " BEGIN INSERT INTO SyntheticAudit(AuthorizationID) VALUES (NEW.AuthorizationID); END;" +
            "CREATE TABLE SyntheticAuthLinks (LinkID INTEGER PRIMARY KEY, AuthorizationID INTEGER REFERENCES " + quote(name) + "(AuthorizationID) ON DELETE CASCADE, Note TEXT);" +
            "INSERT INTO SyntheticAuthLinks VALUES (1,10,'first'),(2,180,'last');" +
            "CREATE VIEW SyntheticAuthView AS SELECT AuthorizationID, OrderID, ProviderTrace FROM " + quote(name) + ";");
        if (options.version !== undefined) await db.run("PRAGMA user_version = " + options.version);
    });
}
async function assertHistoricalRows(db, before, authName = "PaymentAuthorizations") {
    for (const name of ["Products", "Orders", authName, "Settlements", "SyntheticAudit", "SyntheticAuthLinks"]) {
        const after = await db.allAsync("SELECT * FROM " + quote(name) + " ORDER BY rowid");
        const original = before.rows[name];
        assert.equal(after.length, original.length, name);
        for (let i = 0; i < original.length; i++) {
            for (const [key, value] of Object.entries(original[i])) assert.deepEqual(after[i][key], value, name + "." + key);
        }
    }
}

test("fresh initialization applies v1/v2 and matches the schema mirror", async (t) => {
    const f = fixture(t);
    const db = f.open();
    assert.deepEqual(await db.ready, { fromVersion: 0, toVersion: 2, appliedVersions: [1, 2], existingForeignKeyViolations: 0 });
    assert.equal(CURRENT_SCHEMA_VERSION, 2);
    assert.equal((await db.getAsync("PRAGMA user_version")).user_version, 2);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Products")).count, 5);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0);
    const mirrored = fixture(t);
    const expected = await withRaw(mirrored.filename, async (raw) => {
        await raw.exec(schema);
        return raw.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    });
    assert.deepEqual(await db.allAsync("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), expected);
});

test("nonempty v0 preserves all 5/16/18/9 records and duplicate histories without inventing items", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    const before = await withRaw(f.filename, snapshot);
    const db = f.open(); await db.ready;
    await assertHistoricalRows(db, before);
    for (const [table, count] of [["Products", 5], ["Orders", 16], ["PaymentAuthorizations", 18], ["Settlements", 9], ["OrderItems", 0]]) {
        assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM " + table)).count, count);
    }
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM (SELECT OrderID FROM Settlements GROUP BY OrderID HAVING COUNT(*) > 1)")).count, 3);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM (SELECT OrderID FROM PaymentAuthorizations GROUP BY OrderID HAVING COUNT(*) > 1)")).count, 2);
    assert.equal((await db.getAsync("SELECT OrderStatus FROM Orders WHERE OrderID='SYN-ORDER-01'")).OrderStatus, "Authorized");
    assert.deepEqual(await db.allAsync("PRAGMA foreign_key_check"), []);
});

test("nullable token and FailureReason work, retaining IDs, extra columns, constraints, metadata and sequence high-water", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    const before = await withRaw(f.filename, snapshot);
    const db = f.open(); await db.ready;
    const columns = await db.allAsync("PRAGMA table_info(PaymentAuthorizations)");
    assert.equal(columns.find((row) => row.name === "AuthorizationToken").notnull, 0);
    assert.ok(columns.some((row) => row.name === "FailureReason"));
    for (const name of ["SyntheticAuthByOrder", "SyntheticAuthAudit", "SyntheticAuthView"]) {
        assert.equal((await db.getAsync("SELECT sql FROM sqlite_master WHERE name=?", [name])).sql, before.objects.find((row) => row.name === name).sql);
    }
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM SyntheticAuthView")).count, 18);
    const inserted = await db.runAsync("INSERT INTO PaymentAuthorizations(OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthorizationResult,FailureReason) VALUES (?, NULL, ?, ?, ?, ?)", ["SYN-ORDER-01", 2, "2031-01-01", "Failed", "Synthetic decline"]);
    assert.equal(inserted.lastID, 901);
    const row = await db.getAsync("SELECT * FROM PaymentAuthorizations WHERE AuthorizationID=?", [901]);
    assert.equal(row.AuthorizationToken, null); assert.equal(row.FailureReason, "Synthetic decline");
    assert.equal(row.ProviderTrace, "AuthorizationToken TEXT NOT NULL is only a literal");
    assert.equal((await db.getAsync("SELECT AuthorizationID FROM SyntheticAudit")).AuthorizationID, 901);
    await assert.rejects(db.runAsync("INSERT INTO PaymentAuthorizations(OrderID,AuthorizationAmount,TransactionDateTime,AuthorizationResult) VALUES ('SYN-ORDER-01',-1,'2031-01-02','Failed')"), { code: "SQLITE_CONSTRAINT" });
    await assert.rejects(db.runAsync("INSERT INTO PaymentAuthorizations(OrderID,AuthorizationAmount,TransactionDateTime,AuthorizationResult) VALUES ('SYN-ORDER-01',1,'2031-01-01','Failed')"), { code: "SQLITE_CONSTRAINT" });
    assert.equal((await db.getAsync("SELECT seq FROM sqlite_sequence WHERE name='Settlements'")).seq, 700);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM SyntheticAuthLinks")).count, 2);
});

test("already-nullable v0 adds only FailureReason and preserves existing metadata", async (t) => {
    const f = fixture(t); await legacy(f.filename, { tokenNullable: true });
    const rootPage = await withRaw(f.filename, (db) => db.get("SELECT rootpage FROM sqlite_master WHERE name='PaymentAuthorizations'"));
    const db = f.open(); assert.deepEqual((await db.ready).appliedVersions, [1, 2]);
    assert.equal((await db.getAsync("SELECT rootpage FROM sqlite_master WHERE name='PaymentAuthorizations'")).rootpage, rootPage.rootpage);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 18);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('SyntheticAuthByOrder','SyntheticAuthAudit')")).count, 2);
});

test("mixed-case table and quoted named NOT NULL constraint preserve indexes, triggers and sequence", async (t) => {
    const f = fixture(t); await legacy(f.filename, { tableName: "paymentauthorizations", quotedToken: true });
    const before = await withRaw(f.filename, snapshot);
    const db = f.open(); await db.ready;
    await assertHistoricalRows(db, before, "paymentauthorizations");
    assert.equal((await db.getAsync("SELECT name FROM sqlite_master WHERE name='paymentauthorizations'")).name, "paymentauthorizations");
    assert.equal((await db.getAsync("SELECT seq FROM sqlite_sequence WHERE name='paymentauthorizations'")).seq, 900);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('SyntheticAuthByOrder','SyntheticAuthAudit')")).count, 2);
    const inserted = await db.runAsync("INSERT INTO paymentauthorizations(OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthorizationResult) VALUES ('SYN-ORDER-01',NULL,1,'2031-02-01','Failed')");
    assert.equal(inserted.lastID, 901);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM SyntheticAudit")).count, 1);
});

test("existing FailureReason values survive a token-nullability rebuild", async (t) => {
    const f = fixture(t); await legacy(f.filename, { failureReason: true });
    const before = await withRaw(f.filename, snapshot);
    const db = f.open(); await db.ready; await assertHistoricalRows(db, before);
    assert.equal((await db.getAsync("SELECT FailureReason FROM PaymentAuthorizations WHERE AuthorizationID=20")).FailureReason, "Preserve synthetic failure detail");
});

test("version 1 applies only OrderItems migration", async (t) => {
    const f = fixture(t); await legacy(f.filename, { tokenNullable: true, failureReason: true, version: 1 });
    const before = await withRaw(f.filename, snapshot);
    const db = f.open();
    assert.deepEqual((await db.ready).appliedVersions, [2]);
    await assertHistoricalRows(db, before);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0);
});

test("reopening migrated databases is idempotent and does not rewrite schema or data", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    const first = f.open(); await first.ready; await first.closeAsync();
    const beforeHash = digest(f.filename);
    const before = await withRaw(f.filename, snapshot);
    for (let i = 0; i < 2; i++) {
        const db = f.open();
        assert.deepEqual((await db.ready).appliedVersions, []);
        assert.equal((await db.ready).fromVersion, 2);
        await db.closeAsync();
    }
    assert.deepEqual(await withRaw(f.filename, snapshot), before);
    assert.equal(digest(f.filename), beforeHash);
});

test("concurrent initializers inspect versions under the same write lock", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    const first = f.open(); const second = f.open();
    const reports = await Promise.all([first.ready, second.ready]);
    assert.deepEqual(reports.map((row) => row.fromVersion).sort(), [0, 2]);
    assert.deepEqual(reports.map((row) => row.appliedVersions.length).sort(), [0, 2]);
    assert.equal((await second.getAsync("SELECT COUNT(*) AS count FROM Products")).count, 5);
    assert.equal((await second.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count, 18);
});

async function newOrder(db, id = "ITEM-ORDER") {
    await db.runAsync("INSERT INTO Orders VALUES (?, 'Synthetic','synthetic@example.test','Synthetic','City','ST','00000','2031-01-01',22.5,'Pending')", [id]);
}
const insertItem = "INSERT INTO OrderItems(OrderID,ProductID,ProductName,UnitPriceCents,Quantity) VALUES (?, ?, ?, ?, ?)";

test("OrderItems snapshots survive catalog changes; references and deletion policies work", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    const db = f.open(); await db.ready; await newOrder(db);
    const inserted = await db.runAsync(insertItem, ["ITEM-ORDER", 1, "Synthetic product 1", 1125, 2]);
    const before = await db.getAsync("SELECT * FROM OrderItems WHERE OrderItemID=?", [inserted.lastID]);
    await db.runAsync("UPDATE Products SET Name='Changed catalog name', Price=99.99, ImageURL='/changed.png' WHERE ProductID=1");
    assert.deepEqual(await db.getAsync("SELECT * FROM OrderItems WHERE OrderItemID=?", [inserted.lastID]), before);
    await assert.rejects(db.runAsync("DELETE FROM Products WHERE ProductID=1"), { code: "SQLITE_CONSTRAINT" });
    await db.runAsync("DELETE FROM Orders WHERE OrderID='ITEM-ORDER'");
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count, 16);
});

test("OrderItems enforce integer cents, positive integer quantity, names and foreign keys", async (t) => {
    const db = fixture(t).open(); await db.ready; await newOrder(db);
    for (const values of [
        ["ITEM-ORDER",1,null,100,1], ["ITEM-ORDER",1," ",100,1],
        ["ITEM-ORDER",1,"Item",-1,1], ["ITEM-ORDER",1,"Item",1.5,1], ["ITEM-ORDER",1,"Item",null,1],
        ["ITEM-ORDER",1,"Item",Infinity,1], ["ITEM-ORDER",1,"Item","invalid",1],
        ["ITEM-ORDER",1,"Item",100,0], ["ITEM-ORDER",1,"Item",100,-1], ["ITEM-ORDER",1,"Item",100,1.5],
        ["ITEM-ORDER",1,"Item",100,null], ["ITEM-ORDER",1,"Item",100,Infinity], ["ITEM-ORDER",1,"Item",100,"invalid"],
        ["NONEXISTENT",1,"Item",100,1], ["ITEM-ORDER",999,"Item",100,1],
    ]) await assert.rejects(db.runAsync(insertItem, values), { code: "SQLITE_CONSTRAINT" });
    const first = await db.runAsync(insertItem, ["ITEM-ORDER",1,"Free snapshot",0,1]);
    const second = await db.runAsync(insertItem, ["ITEM-ORDER",1,"Another snapshot",100,2]);
    assert.notEqual(first.lastID, second.lastID);
    await assert.rejects(db.runAsync("INSERT INTO OrderItems(OrderItemID,OrderID,ProductID,ProductName,UnitPriceCents,Quantity) VALUES (?, 'ITEM-ORDER',1,'Item',100,1)", [first.lastID]), { code: "SQLITE_CONSTRAINT" });
    assert.deepEqual(await db.allAsync("PRAGMA foreign_key_check"), []);
});

test("failed order/item transactions leave no partial order or snapshots", async (t) => {
    const db = fixture(t).open(); await db.ready;
    await assert.rejects(db.withTransaction(async (tx) => {
        await tx.run("INSERT INTO Orders VALUES ('ATOMIC','Synthetic','synthetic@example.test','Synthetic','City','ST','00000','2031-01-01',1,'Pending')");
        await tx.run(insertItem, ["ATOMIC",1,"Item",100,1]);
        await tx.run(insertItem, ["ATOMIC",1,"Invalid",100,0]);
    }), { code: "SQLITE_CONSTRAINT" });
    assert.equal(await db.getAsync("SELECT OrderID FROM Orders WHERE OrderID='ATOMIC'"), undefined);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 0);
});

test("failures after either version increment roll back rows/schema/metadata/version and restore settings", async (t) => {
    for (const version of [1, 2]) {
        const f = fixture(t); await legacy(f.filename);
        await withRaw(f.filename, async (raw) => {
            const before = await snapshot(raw);
            const adapter = { ...raw, async run(sql, params) {
                const result = await raw.run(sql, params);
                if (sql === "PRAGMA user_version = " + version) throw new Error("synthetic migration fault");
                return result;
            } };
            await assert.rejects(migrateDatabase(adapter), /synthetic migration fault/);
            assert.deepEqual(await snapshot(raw), before);
            assert.equal((await raw.get("PRAGMA foreign_keys")).foreign_keys, 1);
            assert.equal((await raw.get("PRAGMA legacy_alter_table")).legacy_alter_table, 0);
            assert.equal((await raw.get("SELECT COUNT(*) AS count FROM SyntheticAuthView")).count, 18);
            assert.deepEqual((await migrateDatabase(raw)).appliedVersions, [1, 2]);
        });
    }
});

test("unsupported future and negative versions fail without changing any database bytes", async (t) => {
    for (const version of [-1, 3, 99]) {
        const f = fixture(t); await legacy(f.filename, { version }); const before = digest(f.filename);
        const db = f.open(); await assert.rejects(db.ready, { code: "DB_SCHEMA_VERSION_UNSUPPORTED" });
        await assert.rejects(db.getAsync("SELECT 1"), { code: "DB_SCHEMA_VERSION_UNSUPPORTED" });
        await db.closeAsync(); assert.equal(digest(f.filename), before);
    }
});

test("inconsistent declared versions fail without silently recreating or rewriting history", async (t) => {
    for (const options of [{ version: 1 }, { version: 2, tokenNullable: true, failureReason: true }]) {
        const f = fixture(t); await legacy(f.filename, options); const before = digest(f.filename);
        const db = f.open(); await assert.rejects(db.ready, { code: "DB_SCHEMA_VERSION_MISMATCH" });
        await db.closeAsync(); assert.equal(digest(f.filename), before);
    }
});

test("CHECK expressions mentioned only in comments do not validate a counterfeit OrderItems schema", async (t) => {
    const f = fixture(t); await legacy(f.filename, { tokenNullable: true, failureReason: true, version: 2 });
    const counterfeit = itemSchema.replace(/CHECK\(length\(trim\(ProductName\)\) > 0\)/, "/* CHECK(length(trim(ProductName)) > 0) */")
        .replace(/CHECK\(typeof\(UnitPriceCents\) = 'integer' AND UnitPriceCents >= 0\)/, "/* CHECK(typeof(UnitPriceCents) = 'integer' AND UnitPriceCents >= 0) */")
        .replace(/CHECK\(typeof\(Quantity\) = 'integer' AND Quantity > 0\)/, "/* CHECK(typeof(Quantity) = 'integer' AND Quantity > 0) */");
    await withRaw(f.filename, (raw) => raw.exec(counterfeit));
    const before = digest(f.filename); const db = f.open();
    await assert.rejects(db.ready, { code: "DB_MIGRATION_UNSUPPORTED" });
    await db.closeAsync(); assert.equal(digest(f.filename), before);
});

test("unsafe token CHECK constraints are refused instead of silently weakening or losing them", async (t) => {
    const f = fixture(t); await legacy(f.filename, { tokenCheck: true });
    const before = digest(f.filename); const db = f.open();
    await assert.rejects(db.ready, { code: "DB_MIGRATION_UNSUPPORTED" });
    await db.closeAsync(); assert.equal(digest(f.filename), before);
});

test("existing compatible item snapshots are retained rather than backfilled or replaced", async (t) => {
    const f = fixture(t); await legacy(f.filename, { tokenNullable: true, failureReason: true, version: 1 });
    await withRaw(f.filename, async (raw) => {
        await raw.exec(itemSchema);
        await raw.run("INSERT INTO OrderItems VALUES (444,'SYN-ORDER-01',1,'Known historical snapshot',321,2)");
    });
    const db = f.open(); await db.ready;
    assert.deepEqual(await db.getAsync("SELECT * FROM OrderItems"), { OrderItemID: 444, OrderID: "SYN-ORDER-01", ProductID: 1, ProductName: "Known historical snapshot", UnitPriceCents: 321, Quantity: 2 });
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count, 1);
});

test("pre-existing orphan history is retained and reported; future foreign-key writes are enforced", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    await withRaw(f.filename, async (raw) => {
        await raw.run("PRAGMA foreign_keys = OFF");
        await raw.run("INSERT INTO PaymentAuthorizations(AuthorizationID,OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthorizationResult) VALUES (990,'MISSING-LEGACY-ORDER','synthetic-orphan',1,'2031-01-01','Failed')");
    });
    const db = f.open(); assert.equal((await db.ready).existingForeignKeyViolations, 1);
    assert.equal((await db.getAsync("SELECT AuthorizationID FROM PaymentAuthorizations WHERE AuthorizationID=990")).AuthorizationID, 990);
    assert.equal((await db.getAsync("PRAGMA foreign_keys")).foreign_keys, 1);
    await assert.rejects(db.runAsync("INSERT INTO PaymentAuthorizations(OrderID,AuthorizationAmount,TransactionDateTime,AuthorizationResult) VALUES ('ANOTHER-MISSING',1,'2031-01-02','Failed')"), { code: "SQLITE_CONSTRAINT" });
});


test("fresh product seeds use the five PNG paths expected by storefront PR 4", async (t) => {
    const db = fixture(t).open();
    assert.deepEqual(await db.allAsync("SELECT ImageURL FROM Products ORDER BY ProductID"),
        Array.from({ length: 5 }, (_, i) => ({ ImageURL: "/img/p" + (i + 1) + ".png" })));
});

test("legacy migration and repeated initialization preserve all five existing PNG paths", async (t) => {
    const f = fixture(t); await legacy(f.filename);
    const expected = Array.from({ length: 5 }, (_, i) => ({ ProductID: i + 1, ImageURL: "/img/p" + (i + 1) + ".png" }));
    await withRaw(f.filename, async (raw) => {
        for (const row of expected) await raw.run("UPDATE Products SET ImageURL = ? WHERE ProductID = ?", [row.ImageURL, row.ProductID]);
    });
    const first = f.open(); await first.ready;
    assert.deepEqual(await first.allAsync("SELECT ProductID, ImageURL FROM Products ORDER BY ProductID"), expected);
    await first.closeAsync();
    const second = f.open(); assert.deepEqual((await second.ready).appliedVersions, []);
    assert.deepEqual(await second.allAsync("SELECT ProductID, ImageURL FROM Products ORDER BY ProductID"), expected);
});


test("existing OrderItems must have a unique item primary key and usable integer column types", async (t) => {
    const composite = itemSchema.replace("OrderItemID INTEGER PRIMARY KEY AUTOINCREMENT,", "OrderItemID INTEGER NOT NULL,")
        .replace("    FOREIGN KEY (OrderID)", "    PRIMARY KEY (OrderItemID, OrderID),\n    FOREIGN KEY (OrderID)");
    const wrongType = itemSchema.replace("UnitPriceCents INTEGER", "UnitPriceCents TEXT");
    for (const definition of [composite, wrongType]) {
        const f = fixture(t); await legacy(f.filename, { tokenNullable: true, failureReason: true, version: 2 });
        await withRaw(f.filename, (raw) => raw.exec(definition));
        const before = digest(f.filename); const db = f.open();
        await assert.rejects(db.ready, { code: "DB_MIGRATION_UNSUPPORTED" });
        await db.closeAsync(); assert.equal(digest(f.filename), before);
    }
});
