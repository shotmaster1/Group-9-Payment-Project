/**
 * validation.js — Customer & payment validation (Person A)
 * IS 4880 Group 9 — Manhattan Associates Project 2
 *
 * Works in the browser (functions attach to window.PaymentValidation)
 * and in Node (module.exports) so it can be unit tested.
 */
(function (root) {
  "use strict";

  // ---------- Helpers ----------
  const digitsOnly = (value) => String(value || "").replace(/\D/g, "");
  const isBlank = (value) => String(value ?? "").trim() === "";

  // ---------- Required customer fields ----------
  const REQUIRED_FIELDS = {
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    address: "Street address",
    city: "City",
    state: "State",
    zip: "ZIP code",
    cardNumber: "Card number",
    expiration: "Expiration date",
    cvv: "Security code",
  };

  function validateRequired(data) {
    const errors = {};
    for (const [field, label] of Object.entries(REQUIRED_FIELDS)) {
      if (isBlank(data[field])) errors[field] = `${label} is required.`;
    }
    return errors;
  }

  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
  }

  function validateZip(zip) {
    return /^\d{5}(-\d{4})?$/.test(String(zip).trim());
  }

  // ---------- Card type ----------
  const CARD_TYPES = [
    { type: "amex",       label: "American Express", pattern: /^3[47]/,                lengths: [15],     cvvLength: 4 },
    { type: "visa",       label: "Visa",             pattern: /^4/,                    lengths: [13, 16, 19], cvvLength: 3 },
    { type: "mastercard", label: "Mastercard",       pattern: /^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/, lengths: [16], cvvLength: 3 },
    { type: "discover",   label: "Discover",         pattern: /^(6011|65|64[4-9])/,    lengths: [16, 19], cvvLength: 3 },
  ];

  function detectCardType(cardNumber) {
    const digits = digitsOnly(cardNumber);
    return CARD_TYPES.find((card) => card.pattern.test(digits)) || null;
  }

  // ---------- Luhn checksum (catches typos) ----------
  function luhnCheck(cardNumber) {
    const digits = digitsOnly(cardNumber);
    if (digits.length < 12) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = Number(digits[i]);
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  function validateCardNumber(cardNumber) {
    const digits = digitsOnly(cardNumber);
    const card = detectCardType(digits);
    if (!card) return { valid: false, error: "Card type not supported.", card: null };
    if (!card.lengths.includes(digits.length)) {
      return { valid: false, error: `${card.label} numbers must be ${card.lengths.join(" or ")} digits.`, card };
    }
    if (!luhnCheck(digits)) return { valid: false, error: "Card number is invalid.", card };
    return { valid: true, error: null, card };
  }

  // ---------- Expiration (MM/YY or MM/YYYY) ----------
  function parseExpiration(value) {
    const match = String(value || "").trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
    if (!match) return null;
    const month = Number(match[1]);
    let year = Number(match[2]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12) return null;
    return { month, year };
  }

  function validateExpiration(value, now = new Date()) {
    const exp = parseExpiration(value);
    if (!exp) return { valid: false, error: "Use MM/YY format.", exp: null };
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    // Cards are valid through the end of their expiration month
    if (exp.year < currentYear || (exp.year === currentYear && exp.month < currentMonth)) {
      return { valid: false, error: "Card is expired.", exp };
    }
    if (exp.year > currentYear + 20) return { valid: false, error: "Expiration year is too far out.", exp };
    return { valid: true, error: null, exp };
  }

  // ---------- CVV ----------
  function validateCVV(cvv, card) {
    const expected = card ? card.cvvLength : 3;
    const digits = String(cvv || "").trim();
    if (!/^\d+$/.test(digits) || digits.length !== expected) {
      return { valid: false, error: `Security code must be ${expected} digits.` };
    }
    return { valid: true, error: null };
  }

  // ---------- Masking & formatting (display only) ----------
  function maskCardNumber(cardNumber) {
    const digits = digitsOnly(cardNumber);
    if (digits.length < 4) return "";
    const last4 = digits.slice(-4);
    const card = detectCardType(digits);
    return card && card.type === "amex" ? `•••• •••••• •${last4}` : `•••• •••• •••• ${last4}`;
  }

  /** Live formatting for the input as the user types: "4111111111111111" -> "4111 1111 1111 1111" */
  function formatCardNumber(value) {
    const digits = digitsOnly(value).slice(0, 19);
    const card = detectCardType(digits);
    if (card && card.type === "amex") {
      // Amex groups as 4-6-5
      return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)].filter(Boolean).join(" ");
    }
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  }

  // ---------- Full form validation ----------
  /**
   * Validates the whole checkout form.
   * Returns { valid, errors, payload, display }
   *  - errors:  { fieldName: "message" } for inline error display
   *  - payload: clean data to hand to Person B's payment route (only when valid)
   *  - display: safe values for the UI (masked card, card type)
   */
  function validatePaymentForm(data, now = new Date()) {
    const errors = validateRequired(data);

    if (!errors.email && !validateEmail(data.email)) errors.email = "Enter a valid email address.";
    if (!errors.zip && !validateZip(data.zip)) errors.zip = "Enter a valid 5-digit ZIP code.";

    let card = null;
    if (!errors.cardNumber) {
      const result = validateCardNumber(data.cardNumber);
      card = result.card;
      if (!result.valid) errors.cardNumber = result.error;
    }

    let exp = null;
    if (!errors.expiration) {
      const result = validateExpiration(data.expiration, now);
      exp = result.exp;
      if (!result.valid) errors.expiration = result.error;
    }

    if (!errors.cvv) {
      const result = validateCVV(data.cvv, card);
      if (!result.valid) errors.cvv = result.error;
    }

    const valid = Object.keys(errors).length === 0;

    // NOTE: confirm these field names/formats with Person B before integration.
    const payload = valid
      ? {
          customer: {
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
            email: data.email.trim().toLowerCase(),
            address: data.address.trim(),
            city: data.city.trim(),
            state: data.state.trim().toUpperCase(),
            zip: data.zip.trim(),
          },
          payment: {
            cardNumber: digitsOnly(data.cardNumber), // digits only, no spaces
            cardType: card.type,
            expMonth: exp.month,                     // number, 1-12
            expYear: exp.year,                       // 4-digit number
            cvv: String(data.cvv).trim(),
          },
        }
      : null;

    const display = {
      maskedCard: maskCardNumber(data.cardNumber),
      cardType: card ? card.label : null,
    };

    return { valid, errors, payload, display };
  }

  const PaymentValidation = {
    validateRequired,
    validateEmail,
    validateZip,
    detectCardType,
    luhnCheck,
    validateCardNumber,
    parseExpiration,
    validateExpiration,
    validateCVV,
    maskCardNumber,
    formatCardNumber,
    validatePaymentForm,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PaymentValidation;
  else root.PaymentValidation = PaymentValidation;
})(typeof window !== "undefined" ? window : globalThis);
