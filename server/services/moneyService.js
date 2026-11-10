"use strict";

const MAX_CENTS = Number.MAX_SAFE_INTEGER;
const MAX_CENTS_BIGINT = BigInt(MAX_CENTS);

class MoneyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "MoneyError";
        this.code = code;
    }
}

function toCents(value) {
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "number" && (!Number.isFinite(value) || value < 0))) {
        throw new MoneyError("INVALID_MONEY", "Money must be a finite nonnegative decimal value.");
    }
    if (typeof value === "number" && value > MAX_CENTS / 100) {
        throw new MoneyError("MONEY_OVERFLOW", "Money exceeds the safe integer-cent range.");
    }
    const text = String(value);
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) {
        throw new MoneyError("INVALID_MONEY", "Use a plain decimal value without whitespace, signs, or exponent notation.");
    }
    if (match[2] && match[2].length > 2) {
        throw new MoneyError("MONEY_PRECISION", "Money cannot have more than two decimal places.");
    }
    const whole = match[1].replace(/^0+/, "") || "0";
    if (whole.length > 14) {
        throw new MoneyError("MONEY_OVERFLOW", "Money exceeds the safe integer-cent range.");
    }
    // Decimal parsing avoids binary floating-point multiplication and rounding.
    const cents = BigInt(whole) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
    if (cents > MAX_CENTS_BIGINT) {
        throw new MoneyError("MONEY_OVERFLOW", "Money exceeds the safe integer-cent range.");
    }
    return Number(cents);
}

function requireCents(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new MoneyError("INVALID_CENTS", "Cents must be a nonnegative integer.");
    }
    if (!Number.isSafeInteger(value)) {
        throw new MoneyError("MONEY_OVERFLOW", "Cents exceed the safe integer range.");
    }
}

function fromCents(cents) {
    requireCents(cents);
    const dollars = cents / 100;
    // Some very large safe cent integers cannot round-trip through dollar Numbers.
    if (toCents(dollars) !== cents) {
        throw new MoneyError("MONEY_OVERFLOW", "Numeric dollars would lose cent precision.");
    }
    return dollars;
}

function addCents(left, right) {
    requireCents(left);
    requireCents(right);
    const total = BigInt(left) + BigInt(right);
    if (total > MAX_CENTS_BIGINT) {
        throw new MoneyError("MONEY_OVERFLOW", "Money addition exceeds the safe integer-cent range.");
    }
    return Number(total);
}

function multiplyCents(cents, quantity) {
    requireCents(cents);
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
        throw new MoneyError("INVALID_MULTIPLIER", "Money multiplier must be a nonnegative integer.");
    }
    if (!Number.isSafeInteger(quantity)) {
        throw new MoneyError("MONEY_OVERFLOW", "Money multiplier exceeds the safe integer range.");
    }
    const total = BigInt(cents) * BigInt(quantity);
    if (total > MAX_CENTS_BIGINT) {
        throw new MoneyError("MONEY_OVERFLOW", "Money multiplication exceeds the safe integer-cent range.");
    }
    return Number(total);
}

module.exports = { MAX_CENTS, MoneyError, toCents, fromCents, addCents, multiplyCents };
