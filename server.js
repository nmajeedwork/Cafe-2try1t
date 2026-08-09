require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
const basePrompt = fs.readFileSync(path.join(__dirname, 'system-prompt-milestone4.md'), 'utf8');

const SYSTEM_PROMPT = `${basePrompt}\n\n## Today's Menu (JSON)\n${JSON.stringify(menu, null, 2)}`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ROUNDS = 6;

// Café operating hours ("HH:MM", 24-hour). Adjust here to change hours everywhere.
const CAFE_HOURS = {
  weekday: { open: '07:00', close: '20:00' }, // Mon–Fri
  weekend: { open: '09:00', close: '22:00' } // Sat–Sun
};
// New pickup/delivery orders stop being accepted this many minutes before close.
const CLOSING_BUFFER_MINUTES = 30;

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
  },
  {
    name: 'set_order_type',
    description: "Set whether the order is for pickup or delivery. For pickup orders, include customer_name and pickup_time when known. Enforces café operating hours — may return an error if we're closed, about to close, or the requested pickup time is outside hours.",
    input_schema: {
      type: 'object',
      properties: {
        order_type: { type: 'string', enum: ['pickup', 'delivery'], description: "Either 'pickup' or 'delivery'." },
        customer_name: { type: 'string', description: "Customer's name for the order (pickup orders)." },
        pickup_time: { type: 'string', description: "Requested pickup time for TODAY only, if given (e.g. 'ASAP', '6:15 PM'). There is no date field — this is always checked against today's hours." }
      },
      required: ['order_type']
    }
  },
  {
    name: 'set_delivery_address',
    description: "Store the delivery contact and address for a delivery order. Only call this when the order type is 'delivery'.",
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: "Customer's name for the delivery." },
        phone_number: { type: 'string', description: "Customer's contact phone number." },
        address: { type: 'string', description: 'Full delivery street address.' },
        apartment_unit: { type: 'string', description: 'Apartment or unit number, if applicable.' },
        delivery_instructions: { type: 'string', description: 'Any special delivery instructions.' }
      },
      required: ['customer_name', 'phone_number', 'address']
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

function getHoursForDay(date) {
  const day = date.getDay(); // 0 = Sunday ... 6 = Saturday
  return day === 0 || day === 6 ? CAFE_HOURS.weekend : CAFE_HOURS.weekday;
}

function timeStringToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function formatClock(minutes) {
  let h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const meridiem = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${meridiem}`;
}

function getNextOpeningLabel(now) {
  const todayHours = getHoursForDay(now);
  const openMin = timeStringToMinutes(todayHours.open);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (nowMin < openMin) {
    return `${formatClock(openMin)} today`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowHours = getHoursForDay(tomorrow);
  return `${formatClock(timeStringToMinutes(tomorrowHours.open))} tomorrow`;
}

function parseClockTime(timeStr) {
  const normalized = String(timeStr || '').trim().toLowerCase();
  if (['asap', 'as soon as possible', 'now'].includes(normalized)) {
    return 'now';
  }
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) {
    return null;
  }
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (meridiem) {
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function validateOrderTiming(orderType, pickupTimeStr) {
  const now = new Date();
  const todayHours = getHoursForDay(now);
  const openMin = timeStringToMinutes(todayHours.open);
  const closeMin = timeStringToMinutes(todayHours.close);
  const cutoffMin = closeMin - CLOSING_BUFFER_MINUTES;

  // Delivery, or pickup with no specific time yet: validate against the current moment.
  // New orders stop being accepted once we're within the closing buffer.
  if (orderType === 'delivery' || !pickupTimeStr) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < openMin || nowMin >= cutoffMin) {
      const closedFor = orderType === 'delivery'
        ? "delivery isn't available right now"
        : "we can't schedule a pickup right now";
      return { error: `Sorry, we're closed or about to close, so ${closedFor} — we open again at ${getNextOpeningLabel(now)}.` };
    }
    return { ok: true };
  }

  // Pickup with a specific requested time: validate that time itself against today's hours.
  const parsed = parseClockTime(pickupTimeStr);
  if (parsed === null) {
    return { error: `I couldn't understand the pickup time "${pickupTimeStr}". Could you give a time like "6:15 PM"?` };
  }
  const targetMin = parsed === 'now' ? now.getHours() * 60 + now.getMinutes() : parsed;
  // The cutoff itself is still an acceptable pickup slot — it's the LAST acceptable time.
  if (targetMin < openMin || targetMin > cutoffMin) {
    return {
      error: `Sorry, ${pickupTimeStr} is outside our hours or too close to closing — we open again at ${getNextOpeningLabel(now)}. Could you choose a different pickup time?`
    };
  }
  return { ok: true };
}

function setOrderType(order, input) {
  const orderType = String(input.order_type || '').toLowerCase();
  if (orderType !== 'pickup' && orderType !== 'delivery') {
    return { error: `"${input.order_type}" is not a valid order type. Must be "pickup" or "delivery".` };
  }

  const timing = validateOrderTiming(orderType, orderType === 'pickup' ? input.pickup_time : null);
  if (timing.error) {
    return { error: timing.error };
  }

  order.type = orderType;
  if (orderType === 'pickup') {
    if (input.customer_name) {
      order.customerName = input.customer_name;
    }
    if (input.pickup_time) {
      order.pickupTime = input.pickup_time;
    }
  }
  return {
    success: true,
    order_type: order.type,
    customer_name: order.customerName || null,
    pickup_time: order.pickupTime || null
  };
}

function setDeliveryAddress(order, input) {
  if (!input.customer_name || !input.phone_number || !input.address) {
    return { error: 'customer_name, phone_number, and address are required.' };
  }
  order.deliveryAddress = {
    customerName: input.customer_name,
    phoneNumber: input.phone_number,
    address: input.address,
    apartmentUnit: input.apartment_unit || null,
    deliveryInstructions: input.delivery_instructions || null
  };
  return { success: true, delivery_address: order.deliveryAddress };
}

function executeTool(toolName, input, session) {
  switch (toolName) {
    case 'add_to_cart':
      return addToCart(session.cart, input);
    case 'remove_from_cart':
      return removeFromCart(session.cart, input);
    case 'view_cart':
      return viewCart(session.cart);
    case 'update_customization':
      return updateCustomization(session.cart, input);
    case 'set_order_type':
      return setOrderType(session.order, input);
    case 'set_delivery_address':
      return setDeliveryAddress(session.order, input);
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
  if (!req.session.order) {
    req.session.order = { type: null, deliveryAddress: null, customerName: null, pickupTime: null };
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
          content: JSON.stringify(executeTool(block.name, block.input, req.session))
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

    res.json({ reply, cart: cartSummary(req.session.cart), order: req.session.order });
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(500).json({ error: 'Something went wrong talking to CafeBot. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`2try1t CafeBot listening on http://localhost:${PORT}`);
});
