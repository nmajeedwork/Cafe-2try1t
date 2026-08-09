require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
const basePrompt = fs.readFileSync(path.join(__dirname, 'system-prompt-milestone3.md'), 'utf8');

const SYSTEM_PROMPT = `${basePrompt}\n\n## Today's Menu (JSON)\n${JSON.stringify(menu, null, 2)}`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ROUNDS = 6;

const TOOLS = [
  {
    name: 'add_to_cart',
    description: "Add an item from the menu to the customer's cart. The item name must match a menu item exactly.",
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name of the menu item to add, matching menu.json exactly.' },
        quantity: { type: 'integer', minimum: 1, description: 'How many of this item to add.' },
        size: { type: 'string', description: "Selected size, if the item has sizes (e.g. 'Medium')." },
        customizations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Customizations selected for this item (e.g. ["Oat milk", "Extra shot"]).'
        }
      },
      required: ['item_name', 'quantity']
    }
  },
  {
    name: 'remove_from_cart',
    description: 'Remove an item from the cart by name.',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name of the item to remove from the cart.' }
      },
      required: ['item_name']
    }
  },
  {
    name: 'view_cart',
    description: "Get the current contents of the customer's cart and the running subtotal.",
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'update_customization',
    description: "Replace the customizations on an item already in the cart.",
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name of the cart item to update.' },
        customizations: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of customizations, replacing the existing ones.'
        }
      },
      required: ['item_name', 'customizations']
    }
  }
];

function findMenuItem(itemName) {
  return menu.find((item) => item.name.toLowerCase() === String(itemName || '').toLowerCase());
}

function cartSummary(cart) {
  const items = cart.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    size: item.size,
    customizations: item.customizations,
    lineTotal: Number((item.price * item.quantity).toFixed(2))
  }));
  const subtotal = Number(items.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2));
  return { items, subtotal };
}

function addToCart(cart, input) {
  const menuItem = findMenuItem(input.item_name);
  if (!menuItem) {
    return { error: `"${input.item_name}" is not on the menu.` };
  }

  if (input.size && menuItem.sizes.length && !menuItem.sizes.some((s) => s.toLowerCase() === input.size.toLowerCase())) {
    return {
      error: `"${input.size}" is not an available size for ${menuItem.name}. Available sizes: ${menuItem.sizes.join(', ')}`
    };
  }

  const quantity = Number.isInteger(input.quantity) && input.quantity > 0 ? input.quantity : 1;

  const cartItem = {
    name: menuItem.name,
    quantity,
    size: input.size || (menuItem.sizes[0] || null),
    customizations: input.customizations || [],
    price: menuItem.price
  };

  cart.push(cartItem);
  return { success: true, added: cartItem, cart: cartSummary(cart) };
}

function removeFromCart(cart, input) {
  const before = cart.length;
  const filtered = cart.filter((item) => item.name.toLowerCase() !== String(input.item_name || '').toLowerCase());
  if (filtered.length === before) {
    return { error: `"${input.item_name}" is not in the cart.` };
  }
  cart.length = 0;
  cart.push(...filtered);
  return { success: true, cart: cartSummary(cart) };
}

function viewCart(cart) {
  return cartSummary(cart);
}

function updateCustomization(cart, input) {
  const item = cart.find((i) => i.name.toLowerCase() === String(input.item_name || '').toLowerCase());
  if (!item) {
    return { error: `"${input.item_name}" is not in the cart.` };
  }
  item.customizations = input.customizations || [];
  return { success: true, updated: item, cart: cartSummary(cart) };
}

function executeTool(toolName, input, cart) {
  switch (toolName) {
    case 'add_to_cart':
      return addToCart(cart, input);
    case 'remove_from_cart':
      return removeFromCart(cart, input);
    case 'view_cart':
      return viewCart(cart);
    case 'update_customization':
      return updateCustomization(cart, input);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const app = express();

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true }
  })
);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/chat', async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  if (!userMessage) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  if (!req.session.history) {
    req.session.history = [];
  }
  if (!req.session.cart) {
    req.session.cart = [];
  }

  req.session.history.push({ role: 'user', content: userMessage });

  try {
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: req.session.history
    });

    let rounds = 0;
    while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
      req.session.history.push({ role: 'assistant', content: response.content });

      const toolResults = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(executeTool(block.name, block.input, req.session.cart))
        }));

      req.session.history.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: req.session.history
      });

      rounds += 1;
    }

    let reply;
    if (response.stop_reason === 'tool_use') {
      // Hit MAX_TOOL_ROUNDS while Claude still wanted to call tools. Don't persist the
      // dangling tool_use blocks — the API requires every tool_use to be immediately
      // followed by a matching tool_result, and there isn't one for this response.
      reply = "Sorry, I'm having trouble processing that — could you try rephrasing or breaking it into smaller steps?";
      req.session.history.push({ role: 'assistant', content: reply });
    } else {
      req.session.history.push({ role: 'assistant', content: response.content });
      reply = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    }

    res.json({ reply, cart: cartSummary(req.session.cart) });
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(500).json({ error: 'Something went wrong talking to CafeBot. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`2try1t CafeBot listening on http://localhost:${PORT}`);
});
