const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('message-input');
const cartItemsEl = document.getElementById('cart-items');
const cartTotalEl = document.getElementById('cart-total');

function addMessage(text, role) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function renderCart(cart) {
  cartItemsEl.innerHTML = '';

  if (!cart || !cart.items || cart.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cart-empty';
    empty.textContent = 'Your cart is empty';
    cartItemsEl.appendChild(empty);
    cartTotalEl.textContent = '$0.00';
    return;
  }

  for (const item of cart.items) {
    const row = document.createElement('div');
    row.className = 'cart-item';

    const top = document.createElement('div');
    top.className = 'cart-item-top';
    const name = document.createElement('span');
    name.textContent = item.name;
    const qty = document.createElement('span');
    qty.className = 'cart-item-qty';
    const unitPrice = item.lineTotal / item.quantity;
    qty.textContent = `${item.quantity} × $${unitPrice.toFixed(2)}`;
    top.appendChild(name);
    top.appendChild(qty);
    row.appendChild(top);

    const detailParts = [];
    if (item.size) detailParts.push(item.size);
    if (item.customizations && item.customizations.length) {
      detailParts.push(item.customizations.join(', '));
    }
    if (detailParts.length) {
      const detail = document.createElement('div');
      detail.className = 'cart-item-detail';
      detail.textContent = detailParts.join(' · ');
      row.appendChild(detail);
    }

    cartItemsEl.appendChild(row);
  }

  cartTotalEl.textContent = `$${cart.subtotal.toFixed(2)}`;
}

renderCart(null);
addMessage("Welcome to 2try1t! Ask me about our menu, ingredients, or allergens.", 'assistant');

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  addMessage(text, 'user');
  inputEl.value = '';
  inputEl.disabled = true;
  formEl.querySelector('button').disabled = true;

  const typingEl = showTyping();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: text })
    });

    const data = await res.json();

    typingEl.remove();

    if (!res.ok) {
      addMessage(data.error || 'Something went wrong.', 'error');
    } else {
      addMessage(data.reply, 'assistant');
      renderCart(data.cart);
    }
  } catch (err) {
    typingEl.remove();
    addMessage('Could not reach the server. Please try again.', 'error');
  } finally {
    inputEl.disabled = false;
    formEl.querySelector('button').disabled = false;
    inputEl.focus();
  }
});
