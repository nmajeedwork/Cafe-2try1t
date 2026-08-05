const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('message-input');

function addMessage(text, role) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

addMessage("Welcome to 2try1t! Ask me about our menu, ingredients, or allergens.", 'assistant');

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  addMessage(text, 'user');
  inputEl.value = '';
  inputEl.disabled = true;
  formEl.querySelector('button').disabled = true;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: text })
    });

    const data = await res.json();

    if (!res.ok) {
      addMessage(data.error || 'Something went wrong.', 'error');
    } else {
      addMessage(data.reply, 'assistant');
    }
  } catch (err) {
    addMessage('Could not reach the server. Please try again.', 'error');
  } finally {
    inputEl.disabled = false;
    formEl.querySelector('button').disabled = false;
    inputEl.focus();
  }
});
