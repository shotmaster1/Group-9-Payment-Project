"use strict";

// Shared unchanged Stage 6 policy: explicit-timezone timestamps only.
class AuthorizationExpirationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AuthorizationExpirationError";
        this.code = code;
    }
}

function expirationNanoseconds(value) {
    // Date-only and timezone-free values are deliberately rejected (owner-approved policy).
    const match = typeof value === "string" && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) throw new AuthorizationExpirationError("INVALID_EXPIRATION", "The authorization expiration must be a valid timestamp with an explicit timezone; date-only values cannot be settled.");
    const [, day, hourText, minuteText, secondText = "0", fraction = "", , sign, offsetHourText = "0", offsetMinuteText = "0"] = match;
    const calendar = new Date(day + "T00:00:00.000Z");
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const offsetHour = Number(offsetHourText), offsetMinute = Number(offsetMinuteText);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day ||
        hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
        throw new AuthorizationExpirationError("INVALID_EXPIRATION", "The authorization expiration timestamp is invalid.");
    }
    const offset = (offsetHour * 60 + offsetMinute) * (sign === "-" ? -1 : 1);
    const secondsMs = calendar.getTime() + (hour * 3600 + minute * 60 + second) * 1000 - offset * 60000;
    // Preserve sub-millisecond fractions instead of truncating them via Date.parse.
    return BigInt(secondsMs) * 1000000n + BigInt(fraction.padEnd(9, "0"));
}

module.exports = { expirationNanoseconds, AuthorizationExpirationError };
