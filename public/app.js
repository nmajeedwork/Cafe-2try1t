const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('message-input');
const cartItemsEl = document.getElementById('cart-items');
const cartTotalsEl = document.getElementById('cart-totals');
const newOrderBtn = document.getElementById('new-order-btn');

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

function addTotalRow(label, amount, modifierClass) {
  const row = document.createElement('div');
  row.className = modifierClass ? `cart-total-row ${modifierClass}` : 'cart-total-row';

  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const amountEl = document.createElement('span');
  amountEl.textContent = amount;

  row.appendChild(labelEl);
  row.appendChild(amountEl);
  cartTotalsEl.appendChild(row);
}

function renderCartTotals(subtotal, promotions) {
  cartTotalsEl.innerHTML = '';

  const appliedDeal = promotions && promotions.appliedDeal;

  if (appliedDeal) {
    addTotalRow('Subtotal', `$${subtotal.toFixed(2)}`);
    addTotalRow(appliedDeal.name, `-$${appliedDeal.discount.toFixed(2)}`, 'discount');
    addTotalRow('Total', `$${promotions.discountedTotal.toFixed(2)}`, 'final');
  } else {
    addTotalRow('Total', `$${subtotal.toFixed(2)}`, 'final');
  }
}

function renderCart(cart, promotions) {
  cartItemsEl.innerHTML = '';

  if (!cart || !cart.items || cart.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cart-empty';
    empty.textContent = 'Your cart is empty';
    cartItemsEl.appendChild(empty);
    renderCartTotals(0, null);
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

  renderCartTotals(cart.subtotal, promotions);
}

renderCart(null, null);
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
      renderCart(data.cart, data.promotions);
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

newOrderBtn.addEventListener('click', async () => {
  newOrderBtn.disabled = true;
  try {
    await fetch('/reset', { method: 'POST', credentials: 'same-origin' });
  } catch (err) {
    // Even if the request fails, reload anyway — worst case the old session
    // cookie is still around and the next message picks up stale state again,
    // which is the exact bug this button exists to let the customer escape.
  } finally {
    window.location.reload();
  }
});
