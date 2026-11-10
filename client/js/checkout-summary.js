(function () {
  "use strict";
  window.CheckoutSummary = {
    renderQuote(quote) {
      const items = document.getElementById("checkout-items");
      items.replaceChildren();
      quote.items.forEach(item => {
        const row = document.createElement("div");
        row.className = "checkout-item";
        const name = document.createElement("span");
        name.textContent = `${item.productName} × ${item.quantity}`;
        const price = document.createElement("span");
        price.textContent = `$${(item.lineTotalCents / 100).toFixed(2)}`;
        row.append(name, price);
        items.appendChild(row);
      });
      const formatted = quote.orderTotal.toLocaleString("en-US", { style: "currency", currency: "USD" });
      document.getElementById("checkout-cart-total").textContent = formatted;
      document.getElementById("order-total").textContent = formatted;
      document.getElementById("cart-summary").hidden = false;
    }
  };
})();
