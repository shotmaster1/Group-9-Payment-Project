"use strict";

const defaultDatabase = require("../database/db");
const { MoneyError, toCents, fromCents } = require("./moneyService");
const { expirationNanoseconds: parseExpiration, AuthorizationExpirationError } = require("./authorizationExpiration");

class SettlementError extends Error {
    constructor(code, message, statusCode = 400, details = {}) {
        super(message);
        this.name = "SettlementError";
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

function prepareRequest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
        throw new SettlementError("INVALID_REQUEST", "Supply an Order ID and final shipment amount.");
    }
    const fields = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !["orderId", "finalAmount"].includes(key) || !Object.hasOwn(fields[key], "value"))) {
        throw new SettlementError("INVALID_REQUEST", "Supply only orderId and finalAmount values.");
    }
    const orderId = fields.orderId?.value;
    if (typeof orderId !== "string" || !orderId.trim()) {
        throw new SettlementError("INVALID_ORDER_ID", "A nonblank Order ID is required.");
    }
    let finalCents, finalAmount;
    try {
        finalCents = toCents(fields.finalAmount?.value);
        if (finalCents === 0) throw new MoneyError("INVALID_MONEY", "Amount must be positive.");
        finalAmount = fromCents(finalCents);
    } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        throw new SettlementError("INVALID_AMOUNT", "Enter a positive settlement amount with no more than two decimal places within the safe money range.");
    }
    // Copy input before waiting for the transaction; preserve exact historical IDs.
    return { orderId, finalCents, finalAmount };
}

function expirationNanoseconds(value) {
    try { return parseExpiration(value); }
    catch (error) {
        if (!(error instanceof AuthorizationExpirationError)) throw error;
        throw new SettlementError(error.code, error.message);
    }
}

async function settleOrder(input, { database = defaultDatabase, now = Date.now } = {}) {
    const request = prepareRequest(input);
    if (!database || typeof database.withTransaction !== "function" || typeof now !== "function") {
        throw new TypeError("Settlement requires a central database and a backend clock function.");
    }
    return database.withTransaction(async tx => {
        const order = await tx.get("SELECT OrderID, OrderStatus FROM Orders WHERE OrderID = ?", [request.orderId]);
        if (!order) throw new SettlementError("ORDER_NOT_FOUND", "Order not found.", 404);
        if (order.OrderStatus !== "Authorized") {
            throw new SettlementError("ORDER_NOT_AUTHORIZED", "Only an Authorized order can be settled; verify its current status.");
        }
        const authorization = await tx.get(`
            SELECT AuthorizationID, AuthorizationAmount, AuthExpirationDate, AuthorizationResult,
                   typeof(AuthorizationAmount) AS AmountStorageType
            FROM PaymentAuthorizations WHERE OrderID = ?
            ORDER BY AuthorizationID DESC LIMIT 1`, [request.orderId]);
        if (!authorization) {
            throw new SettlementError("AUTHORIZATION_NOT_FOUND", "No payment authorization was found for this Order ID.", 404);
        }
        if (authorization.AuthorizationResult !== "Success") {
            throw new SettlementError("AUTHORIZATION_UNSUCCESSFUL", "The latest payment authorization was not successful.");
        }
        // Block any recorded history, including inconsistent or rejected legacy rows.
        // Do not add a UNIQUE constraint that would reject preserved historical duplicates.
        if (await tx.get("SELECT SettlementID FROM Settlements WHERE OrderID = ? LIMIT 1", [request.orderId])) {
            throw new SettlementError("ALREADY_RECORDED", "A settlement record already exists for this Order ID; verify its history before proceeding.");
        }
        let authorizedCents, authorizedAmount, unusedAuthorizationAmount;
        try {
            if (typeof authorization.AuthorizationAmount !== "number" || !["integer", "real"].includes(authorization.AmountStorageType)) {
                throw new MoneyError("INVALID_MONEY", "Stored authorization amount must be numeric.");
            }
            authorizedCents = toCents(authorization.AuthorizationAmount);
            if (authorizedCents === 0) throw new MoneyError("INVALID_MONEY", "Authorized amount must be positive.");
            authorizedAmount = fromCents(authorizedCents);
        } catch (error) {
            if (!(error instanceof MoneyError)) throw error;
            throw new SettlementError("INVALID_AUTHORIZED_AMOUNT", "The latest authorization does not contain a valid positive amount within the safe money range.");
        }
        if (request.finalCents > authorizedCents) {
            throw new SettlementError("OVER_AUTHORIZATION", `Failed settlement request: Final amount ($${request.finalAmount.toFixed(2)}) exceeds authorized amount ($${authorizedAmount.toFixed(2)}).`, 400,
                { finalAmount: request.finalAmount, authorizedAmount });
        }
        try {
            // Both operands and their nonnegative difference are safe integer cents.
            unusedAuthorizationAmount = fromCents(authorizedCents - request.finalCents);
        } catch (error) {
            if (!(error instanceof MoneyError)) throw error;
            throw new SettlementError("UNUSED_AMOUNT_RANGE", "The unused authorization amount cannot be represented safely.");
        }
        const expiresAt = expirationNanoseconds(authorization.AuthExpirationDate);
        const currentTime = now();
        if (!Number.isSafeInteger(currentTime) || !Number.isFinite(new Date(currentTime).getTime())) {
            throw new Error("The backend settlement clock is invalid.");
        }
        if (BigInt(currentTime) * 1000000n >= expiresAt) {
            throw new SettlementError("AUTHORIZATION_EXPIRED", "The latest payment authorization has expired.");
        }
        const settlementDate = new Date(currentTime).toISOString();
        const inserted = await tx.run(`INSERT INTO Settlements
            (OrderID, FinalShipmentAmount, SettlementDate, SettlementResult)
            VALUES (?, ?, ?, 'Success')`, [request.orderId, request.finalAmount, settlementDate]);
        if (inserted.changes !== 1) throw new Error("Settlement insert did not save exactly one record.");
        const updated = await tx.run("UPDATE Orders SET OrderStatus = 'Settled' WHERE OrderID = ? AND OrderStatus = 'Authorized'", [request.orderId]);
        if (updated.changes !== 1) throw new Error("Settlement status update did not save exactly one record.");
        return {
            message: "Successful settlement request received",
            orderId: request.orderId,
            finalAmount: request.finalAmount,
            authorizedAmount,
            unusedAuthorizationAmount
        };
    });
}

module.exports = { settleOrder, SettlementError };
