"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CURRENT_SCHEMA_VERSION = 2;
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const definitions = new Map([...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\);/g)]
    .map((match) => [match[1], match[0]]));
const baseColumns = {
    Products: ["ProductID", "Name", "Description", "Price", "ImageURL"],
    Orders: ["OrderID", "CustomerName", "CustomerEmail", "ShippingAddress", "City", "State", "Zip", "OrderDate", "OrderTotal", "OrderStatus"],
    PaymentAuthorizations: ["AuthorizationID", "OrderID", "AuthorizationToken", "AuthorizationAmount", "TransactionDateTime", "AuthExpirationDate", "AuthorizationResult", "CardType", "CardLast4"],
    Settlements: ["SettlementID", "OrderID", "FinalShipmentAmount", "SettlementDate", "SettlementResult"],
};

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function quote(name) { return '"' + name.replace(/"/g, '""') + '"'; }
async function table(db, name) {
    const entry = await db.get("SELECT name, type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE", [name]);
    if (!entry) return null;
    if (entry.type !== "table" || !entry.sql) {
        throw failure("DB_MIGRATION_UNSUPPORTED", "Expected an ordinary table: " + name + ".");
    }
    return { name: entry.name, sql: entry.sql, columns: await db.all("PRAGMA table_xinfo(" + quote(name) + ")") };
}
function column(info, name) {
    return info.columns.find((item) => item.name.toLowerCase() === name.toLowerCase());
}
function requireColumns(info, names, name) {
    if (names.some((item) => !column(info, item))) {
        throw failure("DB_MIGRATION_UNSUPPORTED", "Missing required historical columns in " + name + ".");
    }
}

// Narrow SQL lexer: retain original definitions instead of reconstructing them
// from PRAGMA metadata (which would lose defaults, CHECKs, UNIQUEs, etc.).
function tokens(sql) {
    const pattern = /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|[^\s]/g;
    return [...sql.matchAll(pattern)].filter((match) => !match[0].startsWith("--") && !match[0].startsWith("/*"))
        .map((match) => {
            const text = match[0];
            let value = text;
            const first = text[0];
            if (first === '"' || first === "`" || first === "[") {
                value = text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`");
            }
            return { text, value, start: match.index, end: match.index + text.length, literal: first === "'" };
        });
}
function unsupportedTokenCheck(sql) {
    const parts = tokens(sql);
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].text.toUpperCase() !== "CHECK" || parts[i + 1]?.text !== "(") continue;
        let depth = 0;
        for (let j = i + 1; j < parts.length; j++) {
            if (parts[j].text === "(") depth++;
            if (parts[j].text === ")" && --depth === 0) break;
            if (!parts[j].literal && parts[j].value.toLowerCase() === "authorizationtoken") {
                throw failure("DB_MIGRATION_UNSUPPORTED", "A token CHECK constraint requires a reviewed migration; no records were changed.");
            }
        }
    }
}
function nullableTableSQL(sql, temporaryName) {
    const parts = tokens(sql);
    const open = parts.findIndex((part) => part.text === "(");
    if (open < 0) throw failure("DB_MIGRATION_UNSUPPORTED", "Cannot safely parse authorization schema.");
    let depth = 1;
    let start = open + 1;
    let target;
    for (let i = open + 1; i < parts.length; i++) {
        const part = parts[i];
        if (part.text === "(") depth++;
        if (part.text === ")") depth--;
        if ((part.text === "," && depth === 1) || depth === 0) {
            if (parts[start]?.value.toLowerCase() === "authorizationtoken") target = parts.slice(start, i);
            start = i + 1;
        }
        if (depth === 0) break;
    }
    if (!target) throw failure("DB_MIGRATION_UNSUPPORTED", "Authorization token column was not found.");
    let removal;
    depth = 0;
    for (let i = 1; i < target.length; i++) {
        if (target[i].text === "(") depth++;
        if (target[i].text === ")") depth--;
        if (depth !== 0) continue;
        const word = target[i].text.toUpperCase();
        const pair = word === "NOT" && target[i + 1]?.text.toUpperCase() === "NULL";
        if (!pair && word !== "NOTNULL") continue;
        let first = i;
        let last = pair ? i + 1 : i;
        if (target[i - 2]?.text.toUpperCase() === "CONSTRAINT") first = i - 2;
        if (target[last + 1]?.text.toUpperCase() === "ON" && target[last + 2]?.text.toUpperCase() === "CONFLICT") {
            if (!/^(ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)$/i.test(target[last + 3]?.text || "")) {
                throw failure("DB_MIGRATION_UNSUPPORTED", "Unsupported token conflict clause.");
            }
            last += 3;
        }
        removal = { start: target[first].start, end: target[last].end };
        break;
    }
    if (!removal) throw failure("DB_MIGRATION_UNSUPPORTED", "Cannot safely remove token NOT NULL constraint.");
    return "CREATE TABLE " + quote(temporaryName) + " " + sql.slice(parts[open].start, removal.start) +
        " " + sql.slice(removal.end);
}

async function inspectBase(db, version) {
    for (const [name, columns] of Object.entries(baseColumns)) {
        const info = await table(db, name);
        if (!info) {
            if (version > 0) throw failure("DB_SCHEMA_VERSION_MISMATCH", "Declared schema version is missing " + name + ".");
            continue;
        }
        requireColumns(info, columns, name);
        if (name !== "PaymentAuthorizations") continue;
        const token = column(info, "AuthorizationToken");
        if (info.columns.some((item) => item.hidden) || token.pk) {
            throw failure("DB_MIGRATION_UNSUPPORTED", "Generated/hidden authorization columns or token primary keys need a reviewed migration.");
        }
        unsupportedTokenCheck(info.sql);
        if (version >= 1 && (token.notnull || !column(info, "FailureReason"))) {
            throw failure("DB_SCHEMA_VERSION_MISMATCH", "Authorization schema does not match its declared version.");
        }
    }
}

async function authorizationMigration(db) {
    let info = await table(db, "PaymentAuthorizations");
    const originalName = info.name;
    if (column(info, "AuthorizationToken").notnull) {
        const temporaryName = "__g9_payment_authorizations_v1";
        if (await db.get("SELECT name FROM sqlite_master WHERE name = ? COLLATE NOCASE", [temporaryName])) {
            throw failure("DB_MIGRATION_UNSUPPORTED", "Reserved migration table name already exists.");
        }
        const replacementSQL = nullableTableSQL(info.sql, temporaryName);
        const extras = await db.all("SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name", [originalName]);
        const sequences = await db.all("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?", [originalName]);
        if (sequences.length > 1) throw failure("DB_MIGRATION_UNSUPPORTED", "Duplicate authorization sequence metadata requires review.");
        await db.exec(replacementSQL);
        const names = info.columns.map((item) => quote(item.name)).join(", ");
        await db.run("INSERT INTO " + quote(temporaryName) + " (" + names + ") SELECT " + names + " FROM " + quote(originalName));
        await db.run("DROP TABLE " + quote(originalName));
        // legacy_alter_table avoids rewriting/breaking dependent views and FKs
        // during the brief interval in which the original table name is absent.
        await db.run("ALTER TABLE " + quote(temporaryName) + " RENAME TO " + quote(originalName));
        for (const item of extras) await db.exec(item.sql);
        if (sequences.length) {
            const updated = await db.run("UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = ?", [sequences[0].seq, originalName]);
            if (!updated.changes) await db.run("INSERT INTO sqlite_sequence(name, seq) VALUES (?, CAST(? AS INTEGER))", [originalName, sequences[0].seq]);
        } else {
            await db.run("DELETE FROM sqlite_sequence WHERE name = ?", [originalName]);
        }
        info = await table(db, "PaymentAuthorizations");
    }
    if (!column(info, "FailureReason")) {
        await db.run("ALTER TABLE " + quote(originalName) + " ADD COLUMN FailureReason TEXT");
    }
}

async function inspectItems(db) {
    const info = await table(db, "OrderItems");
    if (!info) throw failure("DB_SCHEMA_VERSION_MISMATCH", "OrderItems is missing from the declared schema.");
    const names = ["OrderItemID", "OrderID", "ProductID", "ProductName", "UnitPriceCents", "Quantity"];
    requireColumns(info, names, "OrderItems");
    const id = column(info, "OrderItemID");
    const checks = new Set();
    const parts = tokens(info.sql);
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].text.toUpperCase() !== "CHECK" || parts[i + 1]?.text !== "(") continue;
        let depth = 1;
        const expression = [];
        for (let j = i + 2; j < parts.length; j++) {
            if (parts[j].text === "(") depth++;
            if (parts[j].text === ")") depth--;
            if (depth === 0) { checks.add(expression.join("")); break; }
            expression.push(parts[j].literal ? parts[j].text : parts[j].value.toUpperCase());
        }
    }
    const expectedTypes = { OrderID: "TEXT", ProductID: "INTEGER", ProductName: "TEXT", UnitPriceCents: "INTEGER", Quantity: "INTEGER" };
    const valid = id.pk === 1 && info.columns.filter((item) => item.pk).length === 1 &&
        id.type.toUpperCase() === "INTEGER" &&
        Object.entries(expectedTypes).every(([name, type]) => column(info, name).type.toUpperCase() === type) &&
        names.slice(1).every((name) => column(info, name).notnull) &&
        checks.has("TYPEOF(UNITPRICECENTS)='integer'ANDUNITPRICECENTS>=0") &&
        checks.has("TYPEOF(QUANTITY)='integer'ANDQUANTITY>0") &&
        checks.has("LENGTH(TRIM(PRODUCTNAME))>0");
    const foreignKeys = await db.all("PRAGMA foreign_key_list(OrderItems)");
    if (!valid || !foreignKeys.some((fk) => fk.from === "OrderID" && fk.table === "Orders" && fk.to === "OrderID" && fk.on_delete === "CASCADE") ||
        !foreignKeys.some((fk) => fk.from === "ProductID" && fk.table === "Products" && fk.to === "ProductID" && fk.on_delete === "RESTRICT")) {
        throw failure("DB_MIGRATION_UNSUPPORTED", "Existing OrderItems constraints need a reviewed migration; historical items were not rebuilt.");
    }
}

async function foreignKeyState(db) {
    const rows = await db.all('SELECT "table", CAST(rowid AS TEXT) AS rowid, parent, fkid FROM pragma_foreign_key_check');
    return rows.map((row) => JSON.stringify([row.table, row.rowid, row.parent, row.fkid])).sort();
}

// Internal initialization adapter: raw Promise helpers on one owned connection.
// All migrations, seeds, and version increments form one atomic unit.
async function migrateDatabase(db, seed = async () => {}) {
    let began = false;
    let error;
    let report;
    const originalLegacy = (await db.get("PRAGMA legacy_alter_table")).legacy_alter_table;
    try {
        await db.run("PRAGMA foreign_keys = OFF");
        if ((await db.get("PRAGMA foreign_keys")).foreign_keys !== 0) {
            throw failure("DB_MIGRATION_CONTEXT", "Migrations must run outside an existing transaction.");
        }
        await db.run("PRAGMA legacy_alter_table = ON");
        await db.run("BEGIN IMMEDIATE");
        began = true;
        const version = (await db.get("PRAGMA user_version")).user_version;
        if (!Number.isInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION) {
            throw failure("DB_SCHEMA_VERSION_UNSUPPORTED", "Database version is not supported by this checkout.");
        }
        await inspectBase(db, version);
        if (version >= 2) await inspectItems(db);
        const before = await foreignKeyState(db);
        const appliedVersions = [];
        if (version === 0) {
            for (const name of Object.keys(baseColumns)) await db.exec(definitions.get(name));
            await authorizationMigration(db);
            await db.run("PRAGMA user_version = 1");
            appliedVersions.push(1);
        }
        if (version < 2) {
            await db.exec(definitions.get("OrderItems"));
            await inspectItems(db);
            await db.run("PRAGMA user_version = 2");
            appliedVersions.push(2);
        }
        await seed(db);
        await inspectBase(db, CURRENT_SCHEMA_VERSION);
        const after = await foreignKeyState(db);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            throw failure("DB_MIGRATION_FOREIGN_KEY", "Migration changed foreign-key integrity; all changes were rolled back.");
        }
        report = { fromVersion: version, toVersion: CURRENT_SCHEMA_VERSION, appliedVersions, existingForeignKeyViolations: before.length };
        await db.run("COMMIT");
        began = false;
    } catch (caught) {
        error = caught;
        if (began) {
            try { await db.run("ROLLBACK"); }
            catch (rollbackError) { error.rollbackError = rollbackError; }
        }
    } finally {
        try {
            await db.run("PRAGMA legacy_alter_table = " + (originalLegacy ? "ON" : "OFF"));
            await db.run("PRAGMA foreign_keys = ON");
            if ((await db.get("PRAGMA foreign_keys")).foreign_keys !== 1) {
                throw failure("DB_FOREIGN_KEYS_DISABLED", "Foreign-key enforcement could not be restored.");
            }
        } catch (restoreError) {
            if (error) error.restoreError = restoreError;
            else error = restoreError;
        }
    }
    if (error) throw error;
    return report;
}

module.exports = { CURRENT_SCHEMA_VERSION, migrateDatabase };
