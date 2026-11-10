"use strict";

const defaultDatabase = require("../database/db");
const { MoneyError, toCents, fromCents, addCents, multiplyCents } = require("./moneyService");

const MAX_CART_ITEMS = 100;
const MAX_QUANTITY = 999;

class PricingError extends Error {
    constructor(code, message, productId, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = "PricingError";
        this.code = code;
        if (productId !== undefined) this.productId = productId;
    }
}

function validateCart(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CART_ITEMS) {
        throw new PricingError("INVALID_CART", "Cart must contain between 1 and " + MAX_CART_ITEMS + " items.");
    }
    const seen = new Set();
    return Array.from(items, (item) => {
        if (!item || typeof item !== "object" || Array.isArray(item) ||
            (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
            throw new PricingError("INVALID_CART_ITEM", "Each cart item must be an object containing only productId and quantity.");
        }
        const keys = Reflect.ownKeys(item);
        const fields = Object.getOwnPropertyDescriptors(item);
        if (keys.length !== 2 || !Object.hasOwn(fields, "productId") || !Object.hasOwn(fields, "quantity") ||
            !Object.hasOwn(fields.productId, "value") || !Object.hasOwn(fields.quantity, "value")) {
            throw new PricingError("INVALID_CART_ITEM", "Each cart item must contain only productId and quantity values.");
        }
        const productId = fields.productId.value;
        const quantity = fields.quantity.value;
        if (!Number.isSafeInteger(productId) || productId <= 0) {
            throw new PricingError("INVALID_PRODUCT_ID", "Product IDs must be positive safe integers.");
        }
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
            throw new PricingError("INVALID_QUANTITY", "Quantity must be an integer between 1 and " + MAX_QUANTITY + ".", productId);
        }
        if (seen.has(productId)) {
            throw new PricingError("DUPLICATE_PRODUCT", "Duplicate product entries are not allowed.", productId);
        }
        seen.add(productId);
        // Snapshot inputs before awaiting database initialization or a queued transaction.
        return { productId, quantity };
    });
}

async function calculate(items, tx) {
    const placeholders = items.map(() => "?").join(", ");
    const rows = await tx.all("SELECT ProductID, Name, Price, typeof(Price) AS PriceStorageType FROM Products WHERE ProductID IN (" + placeholders + ")", items.map((item) => item.productId));
    if (!Array.isArray(rows)) throw new PricingError("INVALID_PRODUCT_DATA", "Product query returned an invalid result.");
    const products = new Map(rows.map((row) => [row.ProductID, row]));
    let totalCents = 0;
    const pricedItems = [];
    for (const item of items) {
        const product = products.get(item.productId);
        if (!product) throw new PricingError("PRODUCT_NOT_FOUND", "A cart product does not exist.", item.productId);
        if (typeof product.Name !== "string" || !product.Name.trim()) {
            throw new PricingError("INVALID_PRODUCT_NAME", "A product has no usable name snapshot.", item.productId);
        }
        let unitPriceCents;
        try {
            if (typeof product.Price !== "number" || !["integer", "real"].includes(product.PriceStorageType)) {
                throw new MoneyError("INVALID_MONEY", "Stored product price is not numeric.");
            }
            unitPriceCents = toCents(product.Price);
        } catch (error) {
            if (!(error instanceof MoneyError)) throw error;
            throw new PricingError("INVALID_PRODUCT_PRICE", "A product price is invalid or cannot be represented safely in cents.", item.productId, error);
        }
        let lineTotalCents;
        try {
            lineTotalCents = multiplyCents(unitPriceCents, item.quantity);
            totalCents = addCents(totalCents, lineTotalCents);
        } catch (error) {
            if (!(error instanceof MoneyError)) throw error;
            throw new PricingError("CART_TOTAL_OVERFLOW", "Cart total exceeds the safe money range.", item.productId, error);
        }
        pricedItems.push({ productId: item.productId, productName: product.Name, quantity: item.quantity, unitPriceCents, lineTotalCents });
    }
    let orderTotal;
    try { orderTotal = fromCents(totalCents); }
    catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        throw new PricingError("CART_TOTAL_OVERFLOW", "Cart total cannot be returned as numeric dollars without losing cents.", undefined, error);
    }
    return { items: pricedItems, totalCents, orderTotal };
}

async function priceCart(items, options = {}) {
    const validated = validateCart(items);
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Pricing options must be an object.");
    }
    if (Object.hasOwn(options, "transaction")) {
        if (Object.hasOwn(options, "database") || !options.transaction || typeof options.transaction.all !== "function") {
            throw new TypeError("Supply either a database or its transaction, not both.");
        }
        return calculate(validated, options.transaction);
    }
    const database = Object.hasOwn(options, "database") ? options.database : defaultDatabase;
    if (!database || typeof database.withTransaction !== "function") throw new TypeError("Pricing requires the central database transaction API.");
    // A single snapshot across every product; no nested transaction in Stage 4.
    return database.withTransaction((tx) => calculate(validated, tx));
}

module.exports = { priceCart, validateCart, PricingError, MAX_CART_ITEMS, MAX_QUANTITY };
