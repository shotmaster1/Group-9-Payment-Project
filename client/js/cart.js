
let products = [];
let cart = [];

// Get the elements from index.html
const productsContainer = document.getElementById("products");
const cartItemsContainer = document.getElementById("cartItems");
const cartTotalElement = document.getElementById("cartTotal");
const checkoutButton = document.getElementById("checkoutButton");

// 1. Load products from our backend/database
async function loadProducts() {
  try {
    const response = await fetch("/api/products");
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error("Failed to load products");
    }

    products = data.products;
    displayProducts();

  } catch (error) {
    console.error("Product loading error:", error);
    productsContainer.textContent = "Unable to load products.";
  }
}

// 2. Display products on the storefront
function displayProducts() {
  productsContainer.innerHTML = "";

  products.forEach(product => {
    const card = document.createElement("div");
    card.className = "product-card";

    if (product.ImageURL) {
      const img = document.createElement("img");
      img.src = product.ImageURL;
      img.alt = product.Name;
      card.appendChild(img);
    }

    const name = document.createElement("h3");
    name.textContent = product.Name;

    const description = document.createElement("p");
    description.className = "description";
    description.textContent = product.Description || "";

    const price = document.createElement("p");
    price.className = "price";
    price.textContent = `$${Number(product.Price).toFixed(2)}`;

    const button = document.createElement("button");
    button.textContent = "Add to Cart";
    button.addEventListener("click", () => addToCart(product));

    card.append(name, description, price, button);
    productsContainer.appendChild(card);
  });
}

// 3. Add a product to the cart
function addToCart(product) {
  const existingItem = cart.find(
    item => item.ProductID === product.ProductID
  );

  if (existingItem) {
    existingItem.quantity++;
  } else {
    cart.push({
      ...product,
      quantity: 1
    });
  }

  displayCart();
}

// 4. Change the quantity of a cart item
function changeQuantity(productId, change) {
  const item = cart.find(
    item => item.ProductID === productId
  );

  if (!item) return;

  item.quantity += change;

  if (item.quantity <= 0) {
    removeFromCart(productId);
    return;
  }

  displayCart();
}

// 5. Remove a product from the cart
function removeFromCart(productId) {
  cart = cart.filter(
    item => item.ProductID !== productId
  );

  displayCart();
}

// 6. Display cart items and calculate the total
function displayCart() {
  cartItemsContainer.innerHTML = "";

  if (cart.length === 0) {
    cartItemsContainer.textContent = "Your cart is empty.";
  }

  let total = 0;

  cart.forEach(item => {
    const itemTotal = Number(item.Price) * item.quantity;
    total += itemTotal;

    const row = document.createElement("div");
    row.className = "cart-item";

    const details = document.createElement("p");
    details.textContent =
      `${item.Name} - $${itemTotal.toFixed(2)}`;

    const quantity = document.createElement("p");
    quantity.textContent = `Quantity: ${item.quantity}`;

    const actions = document.createElement("div");
    actions.className = "cart-actions";

    const minusButton = document.createElement("button");
    minusButton.textContent = "−";
    minusButton.addEventListener("click", () => {
      changeQuantity(item.ProductID, -1);
    });

    const plusButton = document.createElement("button");
    plusButton.textContent = "+";
    plusButton.addEventListener("click", () => {
      changeQuantity(item.ProductID, 1);
    });

    const removeButton = document.createElement("button");
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      removeFromCart(item.ProductID);
    });

    actions.append(minusButton, plusButton, removeButton);
    row.append(details, quantity, actions);
    cartItemsContainer.appendChild(row);
  });

  cartTotalElement.textContent = total.toFixed(2);
  checkoutButton.disabled = cart.length === 0;
}

// 7. Send the actual cart total to checkout
checkoutButton.addEventListener("click", () => {
  const total = cart.reduce(
    (sum, item) => sum + Number(item.Price) * item.quantity,
    0
  );

  if (cart.length === 0 || total <= 0) return;

  window.location.href =
    `checkout.html?amount=${total.toFixed(2)}`;
});

// Initialize the storefront
loadProducts();
displayCart();
