-- Current schema: version 2. user_version is managed by migrations.js.
CREATE TABLE IF NOT EXISTS Products (
    ProductID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT NOT NULL,
    Description TEXT,
    Price REAL NOT NULL,
    ImageURL TEXT
);

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
);

CREATE TABLE IF NOT EXISTS PaymentAuthorizations (
    AuthorizationID INTEGER PRIMARY KEY AUTOINCREMENT,
    OrderID TEXT NOT NULL,
    AuthorizationToken TEXT,
    AuthorizationAmount REAL NOT NULL,
    TransactionDateTime TEXT NOT NULL,
    AuthExpirationDate TEXT,
    AuthorizationResult TEXT NOT NULL,
    CardType TEXT,
    CardLast4 TEXT,
    FailureReason TEXT,
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Settlements (
    SettlementID INTEGER PRIMARY KEY AUTOINCREMENT,
    OrderID TEXT NOT NULL,
    FinalShipmentAmount REAL NOT NULL,
    SettlementDate TEXT NOT NULL,
    SettlementResult TEXT NOT NULL,
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE CASCADE
);

-- Snapshot values are written when an order is created, never joined from current prices.
CREATE TABLE IF NOT EXISTS OrderItems (
    OrderItemID INTEGER PRIMARY KEY AUTOINCREMENT,
    OrderID TEXT NOT NULL,
    ProductID INTEGER NOT NULL,
    ProductName TEXT NOT NULL CHECK(length(trim(ProductName)) > 0),
    UnitPriceCents INTEGER NOT NULL CHECK(typeof(UnitPriceCents) = 'integer' AND UnitPriceCents >= 0),
    Quantity INTEGER NOT NULL CHECK(typeof(Quantity) = 'integer' AND Quantity > 0),
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE CASCADE,
    FOREIGN KEY (ProductID) REFERENCES Products(ProductID) ON DELETE RESTRICT
);
