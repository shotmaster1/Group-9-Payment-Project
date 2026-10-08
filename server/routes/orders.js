const express = require("express");
const router = express.Router();
const db = require("../database/db");

router.post("/", (req, res) => {
  const { orderId, customer, amount } = req.body;

  if (!customer || !customer.firstName || !customer.email || !customer.address) {
    return res.status(400).json({ success: false, message: "Missing required customer order fields." });
  }

  const idToUse = orderId || `ORD-${Date.now()}`;
  const fullName = `${customer.firstName} ${customer.lastName}`.trim();
  const orderDate = new Date().toISOString();
  const orderTotal = Number(amount || 0);

  const sql = `
    INSERT INTO Orders (OrderID, CustomerName, CustomerEmail, ShippingAddress, City, State, Zip, OrderDate, OrderTotal, OrderStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')
  `;

  const params = [
    idToUse,
    fullName,
    customer.email,
    customer.address,
    customer.city || "",
    customer.state || "",
    customer.zip || "",
    orderDate,
    orderTotal
  ];

  db.run(sql, params, function (err) {
    if (err) {
      return res.status(500).json({ success: false, message: "Database Error: " + err.message });
    }
    return res.status(201).json({
      success: true,
      message: "Order created successfully.",
      orderId: idToUse,
      orderTotal: orderTotal,
      orderStatus: "Pending"
    });
  });
});

router.get("/", (req, res) => {
  const query = `
    SELECT 
      o.OrderID,
      o.CustomerName,
      o.CustomerEmail,
      o.ShippingAddress,
      o.City,
      o.State,
      o.Zip,
      o.OrderDate,
      o.OrderTotal,
      o.OrderStatus,
      pa.AuthorizationToken,
      pa.AuthorizationAmount,
      pa.TransactionDateTime,
      pa.AuthExpirationDate,
      pa.AuthorizationResult
    FROM Orders o
    LEFT JOIN PaymentAuthorizations pa ON o.OrderID = pa.OrderID
    ORDER BY o.OrderDate DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Failed to retrieve orders: " + err.message });
    }
    return res.status(200).json({ success: true, orders: rows });
  });
});

module.exports = router;