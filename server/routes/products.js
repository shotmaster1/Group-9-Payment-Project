const express = require("express");
const router = express.Router();
const db = require("../database/db");

router.get("/", (req, res) => {
  const sql = `
    SELECT ProductID, Name, Description, Price, ImageURL
    FROM Products
    ORDER BY ProductID
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("Error loading products:", err.message);

      return res.status(500).json({
        success: false,
        message: "Could not load products."
      });
    }

    res.json({
      success: true,
      products: rows
    });
  });
});

module.exports = router;