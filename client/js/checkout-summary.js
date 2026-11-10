
const savedCart = sessionStorage.getItem("group9Cart");

const cartSummary = document.getElementById("cart-summary");
const checkoutItems = document.getElementById("checkout-items");
const checkoutCartTotal = document.getElementById("checkout-cart-total");

function displayCheckoutSummary() {
  if (!savedCart) return;

  try {
    const cart = JSON.parse(savedCart);

    if (!Array.isArray(cart) || cart.length === 0) {
      return;
    }

    let total = 0;
    const rows = [];

    cart.forEach(item => {
      const price = Number(item.Price);
      const quantity = Number(item.quantity);

      if (
        !Number.isFinite(price) ||
        price < 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return;
      }

      const itemTotal = price * quantity;
      total += itemTotal;

      rows.push({
        name: String(item.Name || "Product"),
        quantity,
        itemTotal
      });
    });

    if (rows.length === 0) return;

    // Display only if the saved cart matches the checkout URL.
    const params = new URLSearchParams(window.location.search);
    const checkoutAmount = Number(params.get("amount"));

    if (
      !params.has("amount") ||
      !Number.isFinite(checkoutAmount) ||
      Math.round(total * 100) !== Math.round(checkoutAmount * 100)
    ) {
      console.warn("Cart total does not match checkout amount.");
      return;
    }

    rows.forEach(item => {
      const row = document.createElement("div");
      row.className = "checkout-item";

      const name = document.createElement("span");
      name.textContent = `${item.name} × ${item.quantity}`;

      const price = document.createElement("span");
      price.textContent = `$${item.itemTotal.toFixed(2)}`;

      row.append(name, price);
      checkoutItems.appendChild(row);
    });

    checkoutCartTotal.textContent = `$${total.toFixed(2)}`;

    // Reveal the order summary
    cartSummary.hidden = false;

  } catch (error) {
    console.error("Could not display checkout cart:", error);
  }
}

displayCheckoutSummary();
