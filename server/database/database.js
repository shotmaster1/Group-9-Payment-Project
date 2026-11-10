"use strict";

const sqlite3 = require("sqlite3");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { AsyncLocalStorage } = require("node:async_hooks");

const transactionContext = new AsyncLocalStorage();
const { migrateDatabase } = require("./migrations");
const products = [
    ["Trail Backpack", "25L hiking backpack", 64.99, "/img/p1.png"],
    ["Insulated Bottle", "32 oz water bottle", 24.99, "/img/p2.png"],
    ["Trail Cap", "Breathable running cap", 19.99, "/img/p3.png"],
    ["Hiking Socks", "Merino wool trail socks", 14.99, "/img/p4.png"],
    ["Camp Lantern", "Rechargeable LED lantern", 29.99, "/img/p5.png"],
];

function databaseError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validateQuery(sql) {
    if (typeof sql !== "string" || !sql.trim()) {
        throw new TypeError("SQL must be a nonempty string.");
    }
    // Transactions belong to withTransaction(), never an individual queued query.
    const statement = sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, " ").replace(/^[\s;]+/, "");
    if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)) {
        throw databaseError("DB_TRANSACTION_CONTROL", "Use withTransaction() to control transactions.");
    }
}

function createDatabase({ filename, busyTimeoutMs = 5000 } = {}) {
    if (typeof filename !== "string" || !filename.trim()) {
        throw new TypeError("createDatabase requires an explicit filename or :memory:.");
    }
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2147483647) {
        throw new TypeError("busyTimeoutMs must be a nonnegative 32-bit integer.");
    }

    const api = new EventEmitter();
    const resolvedFilename = filename === ":memory:" ? filename : path.resolve(filename);
    let connection;
    let opened = false;
    let closed = false;
    let closing = false;
    let closePromise;
    let fatalError;
    let tail = Promise.resolve();
    const open = new Promise((resolve, reject) => {
        connection = new sqlite3.Database(resolvedFilename, (error) => {
            if (error) return reject(error);
            opened = true;
            resolve();
        });
    });
    const raw = {
        run(sql, params = []) {
            return new Promise((resolve, reject) => {
                connection.run(sql, params, function (error) {
                    if (error) reject(error);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                });
            });
        },
        get(sql, params = []) {
            return new Promise((resolve, reject) => {
                connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
            });
        },
        all(sql, params = []) {
            return new Promise((resolve, reject) => {
                connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
            });
        },
        exec(sql) {
            return new Promise((resolve, reject) => {
                connection.exec(sql, (error) => error ? reject(error) : resolve());
            });
        },
    };

    async function closeConnection() {
        if (!opened || closed) return;
        await new Promise((resolve, reject) => {
            connection.close((error) => error ? reject(error) : resolve());
        });
        closed = true;
    }

    async function initialize() {
        await open;
        connection.configure("busyTimeout", busyTimeoutMs);
        await raw.run("PRAGMA foreign_keys = ON");
        return migrateDatabase(raw, async (db) => {
            const row = await db.get("SELECT COUNT(*) AS count FROM Products");
            if (row.count === 0) {
                for (const product of products) {
                    await db.run("INSERT INTO Products (Name, Description, Price, ImageURL) VALUES (?, ?, ?, ?)", product);
                }
            }
        });
    }

    const ready = initialize().catch(async (error) => {
        fatalError = error;
        try { await closeConnection(); }
        catch (closeError) { error.closeError = closeError; }
        throw error;
    });
    // Preserve ready's rejection for callers without an unhandled startup Promise.
    ready.catch(() => {});

    function inTransaction() {
        const scope = transactionContext.getStore();
        return scope && scope.owner === api && scope.active;
    }

    function enqueue(operation) {
        if (inTransaction()) {
            return Promise.reject(databaseError("DB_TRANSACTION_CONTEXT", "Inside a transaction use the supplied tx helpers, not public database methods."));
        }
        if (fatalError) return Promise.reject(fatalError);
        if (closing || closed) {
            return Promise.reject(databaseError("DB_CLOSED", "Database is closing or closed."));
        }
        const result = tail.then(async () => {
            await ready;
            if (fatalError) throw fatalError;
            return operation();
        });
        // An ordinary SQL error must not poison subsequent independent operations.
        tail = result.catch(() => {});
        return result;
    }

    function query(method, sql, params = []) {
        return enqueue(() => {
            validateQuery(sql);
            return raw[method](sql, params);
        });
    }

    function reportCallbacklessError(error) {
        if (api.listenerCount("error")) api.emit("error", error);
        else console.error("Database operation failed:", error.code || error.name);
    }

    function legacyQuery(method, sql, args) {
        const values = [...args];
        const callback = typeof values.at(-1) === "function" ? values.pop() : undefined;
        const params = values.length === 0 ? [] : values.length === 1 ? values[0] : values;
        query(method, sql, params).then(
            (result) => {
                if (callback) queueMicrotask(() => {
                    if (method === "run") callback.call(result, null);
                    else callback.call(api, null, result);
                });
            },
            (error) => {
                if (callback) queueMicrotask(() => callback.call(api, error));
                else reportCallbacklessError(error);
            }
        );
        return api;
    }

    api.run = (sql, ...args) => legacyQuery("run", sql, args);
    api.get = (sql, ...args) => legacyQuery("get", sql, args);
    api.all = (sql, ...args) => legacyQuery("all", sql, args);
    api.runAsync = (sql, params) => query("run", sql, params);
    api.getAsync = (sql, params) => query("get", sql, params);
    api.allAsync = (sql, params) => query("all", sql, params);
    api.withTransaction = (work) => {
        if (typeof work !== "function") return Promise.reject(new TypeError("Transaction work must be a function."));
        return enqueue(async () => {
            const scope = { owner: api, active: true, accepting: true, pending: [] };
            const tx = {};
            for (const method of ["run", "get", "all"]) {
                tx[method] = (sql, params = []) => {
                    if (!scope.active || !scope.accepting) {
                        return Promise.reject(databaseError("DB_TRANSACTION_CLOSED", "Transaction helpers cannot be used after their callback completes."));
                    }
                    const result = Promise.resolve().then(() => {
                        validateQuery(sql);
                        return raw[method](sql, params);
                    });
                    scope.pending.push(result);
                    result.catch(() => {});
                    return result;
                };
            }
            let began = false;
            try {
                await raw.run("BEGIN IMMEDIATE");
                began = true;
                const result = await transactionContext.run(scope, () => work(tx));
                scope.accepting = false;
                await Promise.all(scope.pending);
                await raw.run("COMMIT");
                began = false;
                return result;
            } catch (error) {
                scope.accepting = false;
                await Promise.allSettled(scope.pending);
                if (began) {
                    try { await raw.run("ROLLBACK"); }
                    catch (rollbackError) {
                        fatalError = databaseError("DB_TRANSACTION_STATE_UNKNOWN", "Rollback failed; close this database before further use.");
                        fatalError.cause = rollbackError;
                        error.rollbackError = rollbackError;
                    }
                }
                throw error;
            } finally {
                scope.active = false;
            }
        });
    };
    api.closeAsync = () => {
        if (inTransaction()) {
            return Promise.reject(databaseError("DB_TRANSACTION_CONTEXT", "Close the database outside a transaction."));
        }
        if (!closePromise) {
            closing = true;
            closePromise = tail.then(async () => {
                try { await ready; } catch { /* Initialization already cleaned up. */ }
                await closeConnection();
            });
            tail = closePromise.catch(() => {});
        }
        return closePromise;
    };
    api.close = (callback) => {
        api.closeAsync().then(
            () => { if (callback) queueMicrotask(() => callback.call(api, null)); },
            (error) => {
                if (callback) queueMicrotask(() => callback.call(api, error));
                else reportCallbacklessError(error);
            }
        );
        return api;
    };
    Object.defineProperties(api, {
        ready: { value: ready, enumerable: true },
        filename: { value: resolvedFilename, enumerable: true },
    });
    return api;
}

// Requiring either module is safe; the default connection is created lazily.
let singleton;
const defaultDatabase = { createDatabase };
function configuredFilename() {
    const filename = process.env.DB_PATH || path.join(__dirname, "ecommerce.db");
    return filename === ":memory:" ? filename : path.resolve(filename);
}
function getDefaultDatabase() {
    if (!singleton) {
        singleton = createDatabase({
            filename: configuredFilename(),
        });
    }
    return singleton;
}
for (const method of ["run", "get", "all", "runAsync", "getAsync", "allAsync", "withTransaction", "on", "once", "removeListener"]) {
    defaultDatabase[method] = (...args) => {
        const database = getDefaultDatabase();
        const result = database[method](...args);
        return result === database ? defaultDatabase : result;
    };
}
defaultDatabase.closeAsync = () => singleton ? singleton.closeAsync() : Promise.resolve();
defaultDatabase.close = (callback) => {
    if (singleton) singleton.close(callback);
    else if (callback) queueMicrotask(() => callback.call(defaultDatabase, null));
    return defaultDatabase;
};
Object.defineProperties(defaultDatabase, {
    ready: { get: () => getDefaultDatabase().ready, enumerable: true },
    filename: { get: () => singleton ? singleton.filename : configuredFilename(), enumerable: true },
});
module.exports = defaultDatabase;
