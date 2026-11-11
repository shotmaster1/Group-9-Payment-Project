"use strict";

const defaultDatabase = require("../database/db");
const { manhattanAuthorizationExpiration, AuthorizationExpirationError } = require("./authorizationExpiration");

function publicAuthorization(authorization) {
    if (!authorization) return authorization;
    try {
        return { ...authorization, AuthExpirationDate: manhattanAuthorizationExpiration(authorization.AuthExpirationDate).utc };
    } catch (error) {
        if (!(error instanceof AuthorizationExpirationError)) throw error;
        // Preserve unsupported historical display values; reads never infer eligibility.
        return authorization;
    }
}

const orderColumns = `
    o.OrderID, o.CustomerName, o.CustomerEmail, o.ShippingAddress,
    o.City, o.State, o.Zip, o.OrderDate, o.OrderTotal, o.OrderStatus`;

class OrderQueryError extends Error {
    constructor(message) {
        super(message);
        this.name = "OrderQueryError";
        this.statusCode = 400;
    }
}

async function listOrders(filters = {}, { database = defaultDatabase } = {}) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
        throw new OrderQueryError("Order query parameters must be text values.");
    }
    const { status, search, sort } = filters;
    if ([status, search, sort].some(value => value !== undefined && typeof value !== "string")) {
        throw new OrderQueryError("Order query parameters must be text values.");
    }
    // Expose only whether a token exists, never the token or free-form failure text.
    let sql = `SELECT ${orderColumns},
        CASE WHEN pa.AuthorizationToken IS NOT NULL AND pa.AuthorizationToken <> ''
            THEN 1 ELSE 0 END AS HasAuthorizationToken,
        pa.AuthorizationAmount, pa.TransactionDateTime,
        pa.AuthExpirationDate, pa.AuthorizationResult, pa.CardType, pa.CardLast4
        FROM Orders o
        LEFT JOIN PaymentAuthorizations pa ON pa.OrderID = o.OrderID
            AND pa.AuthorizationID = (
                SELECT MAX(latest.AuthorizationID) FROM PaymentAuthorizations latest
                WHERE latest.OrderID = o.OrderID
            )
        WHERE 1=1`;
    const params = [];
    if (status) {
        sql += " AND o.OrderStatus = ?";
        params.push(status);
    }
    if (search) {
        sql += " AND (o.OrderID LIKE ? OR o.CustomerEmail LIKE ? OR o.CustomerName LIKE ?)";
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern);
    }
    const sorting = {
        oldest: "o.OrderDate ASC",
        amount_desc: "o.OrderTotal DESC",
        amount_asc: "o.OrderTotal ASC"
    };
    const ordering = Object.hasOwn(sorting, sort) ? sorting[sort] : "o.OrderDate DESC";
    sql += ` ORDER BY ${ordering}, o.OrderID ASC`;
    return (await database.allAsync(sql, params)).map(row => publicAuthorization({
        ...row, HasAuthorizationToken: row.HasAuthorizationToken === 1
    }));
}

async function getOrderDetails(orderId, { database = defaultDatabase } = {}) {
    if (typeof orderId !== "string" || !orderId.trim()) {
        throw new OrderQueryError("A nonblank Order ID is required.");
    }
    // Read all related records in one consistent snapshot. This central helper uses
    // BEGIN IMMEDIATE; keep the scope short and never perform network work here.
    return database.withTransaction(async tx => {
        const order = await tx.get(`SELECT ${orderColumns} FROM Orders o WHERE o.OrderID = ?`, [orderId]);
        if (!order) return null;
        const items = await tx.all(`
            SELECT OrderItemID, OrderID, ProductID, ProductName, UnitPriceCents, Quantity
            FROM OrderItems WHERE OrderID = ? ORDER BY OrderItemID ASC`, [orderId]);
        // Do not use SELECT *: tokens, card fields, and free-form gateway failure
        // details must not enter the new response, even if the schema gains columns.
        const authorization = await tx.get(`
            SELECT AuthorizationID, AuthorizationAmount, TransactionDateTime,
                   AuthExpirationDate, AuthorizationResult
            FROM PaymentAuthorizations WHERE OrderID = ?
            ORDER BY AuthorizationID DESC LIMIT 1`, [orderId]);
        const settlements = await tx.all(`
            SELECT SettlementID, OrderID, FinalShipmentAmount, SettlementDate, SettlementResult
            FROM Settlements WHERE OrderID = ? ORDER BY SettlementID DESC`, [orderId]);
        return { ...order, Items: items, LatestAuthorization: publicAuthorization(authorization) || null, Settlements: settlements };
    });
}

module.exports = { listOrders, getOrderDetails, OrderQueryError };
