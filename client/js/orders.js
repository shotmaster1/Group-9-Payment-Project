let allOrders = [];

async function loadOrders() {
    try {
        const response = await fetch("/api/orders");
        const data = await response.json();

        if (!data.success) {
            console.error("Failed to load orders:", data.message);
            return;
        }

      allOrders = data.orders;
      renderOrders(allOrders);

    } catch (error) {
        console.error("Error loading orders:", error);
    }
}

function renderOrders(orders) {
    const tableBody = document.getElementById("ordersTableBody");

    tableBody.replaceChildren();

    orders.forEach((order) => {
        const row = document.createElement("tr");

        // Keep API values in text nodes, never HTML or inline JavaScript.
        const last4 = String(order.CardLast4 || "");
        const cardType = String(order.CardType || "");
        const cardDisplay = cardType && /^\d{4}$/.test(last4)
            ? `${cardType.charAt(0).toUpperCase() + cardType.slice(1)} •••• ${last4}`
            : "N/A";

        const values = [
            order.OrderID,
            order.CustomerName || "",
            order.CustomerEmail || "",
            `$${Number(order.OrderTotal || 0).toFixed(2)}`,
            order.OrderStatus || "",
            order.OrderDate ? new Date(order.OrderDate).toLocaleString() : "",
            cardDisplay,
            // Indicate authorization availability without exposing the token.
            order.AuthorizationToken ? "Available" : "N/A",
        ];

        values.forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = value ?? "";
            row.appendChild(cell);
        });

        const actionCell = document.createElement("td");
        if (order.OrderStatus === "Authorized") {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Settle Order";
            button.addEventListener("click", () => openSettlement(order.OrderID));
            actionCell.appendChild(button);
        } else {
            actionCell.textContent = "Not Available";
        }
        row.appendChild(actionCell);

        tableBody.appendChild(row);
    });
}

function openSettlement(orderId) {
    window.location.href =
        `warehouse.html?orderId=${encodeURIComponent(orderId)}`;
}

function applyFilters() {
    const selectedSort =
        document.getElementById("sortOrder").value;

    const searchText =
        document.getElementById("searchInput").value.toLowerCase().trim();

    const selectedStatus =
        document.getElementById("statusFilter").value;

    const filteredOrders = allOrders.filter((order) => {

        const matchesSearch =
            order.OrderID.toLowerCase().includes(searchText);

        const matchesStatus =
            selectedStatus === "" ||
            order.OrderStatus === selectedStatus;

        return matchesSearch && matchesStatus;
    });

    filteredOrders.sort((a, b) => {
        const dateA = new Date(a.TransactionDateTime || a.OrderDate);
        const dateB = new Date(b.TransactionDateTime || b.OrderDate);

        if (selectedSort === "oldest") {
            return dateA - dateB;
        }

        return dateB - dateA;
    });

    renderOrders(filteredOrders);
}

document
    .getElementById("searchInput")
    .addEventListener("input", applyFilters);

document
    .getElementById("statusFilter")
    .addEventListener("change", applyFilters);

document
    .getElementById("sortOrder")
    .addEventListener("change", applyFilters);

loadOrders();
