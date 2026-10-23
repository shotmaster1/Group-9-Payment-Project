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

    tableBody.innerHTML = "";

    orders.forEach((order) => {
        const row = document.createElement("tr");

        row.innerHTML = `
            <td>${order.OrderID}</td>
            <td>${order.CustomerName || ""}</td>
            <td>${order.CustomerEmail || ""}</td>
            <td>$${Number(order.OrderTotal || 0).toFixed(2)}</td>
            <td>${order.OrderStatus || ""}</td>
            <td>${order.OrderDate ? new Date(order.OrderDate).toLocaleString() : ""}</td>
           <td>
                ${
                    order.CardType && order.CardLast4
                        ? `${order.CardType.charAt(0).toUpperCase() + order.CardType.slice(1)} •••• ${order.CardLast4}`
                        : "N/A"
                }
            </td>
            <td>${order.AuthorizationToken || "N/A"}</td>
            <td>
                ${
                    order.OrderStatus === "Authorized"
                        ? `<button onclick="openSettlement('${order.OrderID}')">Settle Order</button>`
                        : "Not Available"
                }
            </td>
        `;

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