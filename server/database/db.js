const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.resolve(__dirname, "ecommerce.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error opening SQLite database:", err.message);
  } else {
    console.log("Connected to SQLite database (ecommerce.db).");
  }
});

db.run("PRAGMA foreign_keys = ON;");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS Products (
      ProductID INTEGER PRIMARY KEY AUTOINCREMENT,
      Name TEXT NOT NULL,
      Description TEXT,
      Price REAL NOT NULL,
      ImageURL TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Orders (
      OrderID TEXT PRIMARY KEY,
      CustomerName TEXT NOT NULL,
      CustomerEmail TEXT NOT NULL,
      ShippingAddress TEXT NOT NULL,
      City TEXT NOT NULL,
      State TEXT NOT NULL,
      Zip TEXT NOT NULL,
      OrderDate TEXT NOT NULL,
      OrderTotal REAL NOT NULL,
      OrderStatus TEXT NOT NULL DEFAULT 'Pending'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS PaymentAuthorizations (
      AuthorizationID INTEGER PRIMARY KEY AUTOINCREMENT,
      OrderID TEXT NOT NULL,
      AuthorizationToken TEXT NOT NULL,
      AuthorizationAmount REAL NOT NULL,
      TransactionDateTime TEXT NOT NULL,
      AuthExpirationDate TEXT,
      AuthorizationResult TEXT NOT NULL,
      FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE CASCADE
    )
  `);

  db.get("SELECT COUNT(*) AS count FROM Products", (err, row) => {
    if (!err && row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO Products (Name, Description, Price, ImageURL) VALUES (?, ?, ?, ?)");
      stmt.run("Trail Backpack", "25L hiking backpack", 64.99, "/img/p1.jpg");
      stmt.run("Insulated Bottle", "32 oz water bottle", 24.99, "/img/p2.jpg");
      stmt.run("Trail Cap", "Breathable running cap", 19.99, "/img/p3.jpg");
      stmt.run("Hiking Socks", "Merino wool trail socks", 14.99, "/img/p4.jpg");
      stmt.run("Camp Lantern", "Rechargeable LED lantern", 29.99, "/img/p5.jpg");
      stmt.finalize();
      console.log("Database seeded with sample products.");
    }
  });
});

module.exports = db;