const express = require("express");
const cors = require("cors");
const path = require("path");

// Import database instance and order routes
const db = require("./database/db");
const orderRoutes = require("./routes/orders");

// Import Quentin's payment service (if present)
let paymentService = null;
try {
  paymentService = require("../Payment API");
} catch (e) {
  try {
    paymentService = require("./services/payment");
  } catch (err) {
    console.log("Payment service file loading in simulation fallback mode.");
  }
}

// Import client-side validation logic
const PaymentValidation = require(path.join(__dirname, "../client/js/validation.js"));

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files from client directory
app.use(express.static(path.join(__dirname, "../client")));

// Test endpoint
app.get("/api/test", (req, res) => {
    res.json({ message: "Group 9 server is working" });
});

// Mount Person C Order & Database Routes
app.use("/api/orders", orderRoutes);

// Main Payment Route (Matches checkout.js PAYMENT_ROUTE = "/api/payments")
app.post("/api/payments", async (req, res) => {
  const { orderId, amount, customer, cardNumber, cardMonth, cardYear, ccv, cardType } = req.body;

  if (!cardNumber || !customer) {
    return res.status(400).json({
      success: false,
      status: "Validation Error",
      message: "Missing customer or payment details."
    });
  }

  // Server-side validation
  const cardValidation = PaymentValidation.validateCardNumber(cardNumber);
  if (!cardValidation.valid) {
    return res.status(400).json({
      success: false,
      status: "Card Error",
      message: cardValidation.error
    });
  }

  const idToUse = orderId || `ORD-${Date.now()}`;
  const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
  const orderDate = new Date().toISOString();
  const orderTotal = Number(amount || 0);

  // 1. Insert or Update Order in SQLite Database
  const insertOrderSql = `
    INSERT INTO Orders (OrderID, CustomerName, CustomerEmail, ShippingAddress, City, State, Zip, OrderDate, OrderTotal, OrderStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
    ON CONFLICT(OrderID) DO UPDATE SET OrderStatus='Pending'
  `;

  const orderParams = [
    idToUse,
    fullName,
    customer.email || "",
    customer.address || "",
    customer.city || "",
    customer.state || "",
    customer.zip || "",
    orderDate,
    orderTotal
  ];

  db.run(insertOrderSql, orderParams, async function (err) {
    if (err) {
      console.error("Database Order Insert Error:", err.message);
      return res.status(500).json({
        success: false,
        status: "Server Error",
        message: "Failed to create order record."
      });
    }

    let authSuccess = true;
    let authResultData = {
      authorizationToken: "MA-AUTH-" + Math.random().toString(36).substring(2, 10).toUpperCase(),
      authorizedAmount: orderTotal,
      tokenExpirationDate: "2028-12-31"
    };

    // Call Quentin's payment service if active
    if (paymentService && typeof paymentService.processPayment === "function") {
      try {
        const apiResult = await paymentService.processPayment({
          orderId: idToUse,
          amount: orderTotal,
          cardNumber,
          cardMonth,
          cardYear,
          ccv,
          cardType
        });
        if (apiResult) {
          authSuccess = apiResult.success;
          authResultData = apiResult;
        }
      } catch (apiErr) {
        console.error("External Payment API Exception:", apiErr.message);
      }
    }

    // 2. Persist Authorization Record
    if (authSuccess) {
      const fullAuthToken = `${idToUse}-${authResultData.authorizationToken || "TOK-OK"}`;
      const insertAuthSql = `
        INSERT INTO PaymentAuthorizations 
        (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult)
        VALUES (?, ?, ?, ?, ?, ?)
      `;

      db.run(
        insertAuthSql,
        [idToUse, fullAuthToken, orderTotal, orderDate, authResultData.tokenExpirationDate || "2028-12-31", "Success"],
        function (authErr) {
          if (authErr) console.error("Database Auth Insert Error:", authErr.message);

          db.run(`UPDATE Orders SET OrderStatus = 'Authorized' WHERE OrderID = ?`, [idToUse]);

          return res.status(200).json({
            success: true,
            orderId: idToUse,
            status: "Authorized",
            message: "Payment authorized successfully."
          });
        }
      );
    } else {
      const insertFailedAuthSql = `
        INSERT INTO PaymentAuthorizations 
        (OrderID, AuthorizationToken, AuthorizationAmount, TransactionDateTime, AuthExpirationDate, AuthorizationResult)
        VALUES (?, ?, ?, ?, ?, ?)
      `;

      db.run(insertFailedAuthSql, [idToUse, `${idToUse}-FAILED`, orderTotal, orderDate, "", authResultData.status || "Failed"]);
      db.run(`UPDATE Orders SET OrderStatus = 'Payment Failed' WHERE OrderID = ?`, [idToUse]);

      return res.status(400).json({
        success: false,
        status: authResultData.status || "Payment Declined",
        message: authResultData.message || "Payment processing failed."
      });
    }
  });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});