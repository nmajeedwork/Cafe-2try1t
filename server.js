require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const { speak } = require('./elevenlabs-tts');
const { saveInProgressOrder, clearInProgressOrder, findResumableOrder } = require('./voice-order-recovery');

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
const deals = JSON.parse(fs.readFileSync(path.join(__dirname, 'deals.json'), 'utf8'));
const basePrompt = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8');
const voiceBasePrompt = fs.readFileSync(path.join(__dirname, 'system-prompt-voice.md'), 'utf8');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ROUNDS = 6;
const MAX_RESPONSE_TOKENS = 4096;

// Café operating hours ("HH:MM", 24-hour). Adjust here to change hours everywhere. Close
// time may be past midnight (e.g. "02:00") - validateOrderTiming below handles the
// overnight wraparound.
const CAFE_HOURS = {
  weekday: { open: '05:00', close: '02:00' }, // Mon–Fri
  weekend: { open: '05:00', close: '02:00' } // Sat–Sun
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
  },
  {
    name: 'confirm_order',
    description: "Finalize the order. Only call this after the customer has explicitly approved the final summary. Validates that the cart isn't empty and required order details (order type, and address or pickup name as applicable) are set before confirming.",
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
  // No standalone check_promotions tool - every tool that touches or reports the cart
  // (add_to_cart, remove_from_cart, update_customization, view_cart, confirm_order)
  // already embeds a `promotions` field in its own result (see checkPromotions below).
  // This used to be a separate tool the model was instructed to call after every cart
  // change, which cost a full extra Claude round-trip on nearly every turn - real-call
  // latency logs showed it still happening even after that instruction was added,
  // since a prompt instruction is a suggestion the model can miss under load, not a
  // guarantee. Removing the tool entirely closes that gap deterministically instead of
  // hoping the model remembers not to call it.
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

function round2(n) {
  return Number(n.toFixed(2));
}

function evaluateThresholdDeal(deal, subtotal) {
  if (subtotal >= deal.minSubtotal) {
    return round2(subtotal * (deal.discountPercent / 100));
  }
  return 0;
}

function evaluateComboDeal(deal, cart) {
  let regularTotal = 0;
  for (const required of deal.items) {
    const cartQty = cart
      .filter((item) => item.name.toLowerCase() === required.name.toLowerCase())
      .reduce((sum, item) => sum + item.quantity, 0);
    if (cartQty < required.quantity) {
      return 0;
    }
    const menuItem = findMenuItem(required.name);
    if (!menuItem) {
      return 0;
    }
    regularTotal += menuItem.price * required.quantity;
  }
  const discount = round2(regularTotal - deal.comboPrice);
  return discount > 0 ? discount : 0;
}

function evaluateBogoDeal(deal, cart) {
  const unitPrices = [];
  for (const item of cart) {
    const menuItem = findMenuItem(item.name);
    if (menuItem && menuItem.category === deal.category) {
      for (let i = 0; i < item.quantity; i += 1) {
        unitPrices.push(menuItem.price);
      }
    }
  }
  if (unitPrices.length < 2) {
    return 0;
  }
  unitPrices.sort((a, b) => b - a);
  let discount = 0;
  for (let i = 1; i < unitPrices.length; i += 2) {
    discount += unitPrices[i] * (deal.discountPercent / 100);
  }
  return round2(discount);
}

function checkPromotions(cart) {
  const { subtotal } = cartSummary(cart);

  const evaluated = deals.map((deal) => {
    let discount = 0;
    if (deal.type === 'threshold_discount') {
      discount = evaluateThresholdDeal(deal, subtotal);
    } else if (deal.type === 'combo') {
      discount = evaluateComboDeal(deal, cart);
    } else if (deal.type === 'bogo') {
      discount = evaluateBogoDeal(deal, cart);
    }
    return { id: deal.id, name: deal.name, discount };
  });

  const eligibleDeals = evaluated.filter((deal) => deal.discount > 0);
  // Deals never stack — only the single best-discount deal applies.
  const appliedDeal = eligibleDeals.length
    ? eligibleDeals.reduce((best, deal) => (deal.discount > best.discount ? deal : best))
    : null;
  const discountedTotal = round2(subtotal - (appliedDeal ? appliedDeal.discount : 0));

  return { cartSubtotal: subtotal, eligibleDeals, appliedDeal, discountedTotal };
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
  // Embedding promotions here (same pattern as confirmOrder) saves a full extra
  // Claude round-trip that a separate check_promotions call would otherwise cost on
  // every single cart change — checkPromotions is a pure local calculation, free to
  // include, unlike a real API call.
  return { success: true, added: cartItem, cart: cartSummary(cart), promotions: checkPromotions(cart) };
}

function removeFromCart(cart, input) {
  const before = cart.length;
  const filtered = cart.filter((item) => item.name.toLowerCase() !== String(input.item_name || '').toLowerCase());
  if (filtered.length === before) {
    return { error: `"${input.item_name}" is not in the cart.` };
  }
  cart.length = 0;
  cart.push(...filtered);
  return { success: true, cart: cartSummary(cart), promotions: checkPromotions(cart) };
}

function viewCart(cart) {
  return { ...cartSummary(cart), promotions: checkPromotions(cart) };
}

function updateCustomization(cart, input) {
  const item = cart.find((i) => i.name.toLowerCase() === String(input.item_name || '').toLowerCase());
  if (!item) {
    return { error: `"${input.item_name}" is not in the cart.` };
  }
  item.customizations = input.customizations || [];
  return { success: true, updated: item, cart: cartSummary(cart), promotions: checkPromotions(cart) };
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

// Extends closeMin past 1440 (24:00) when hours cross midnight (e.g. 5am-2am), so the
// open/close window is a normal increasing range instead of close < open. Any raw
// minute-of-day being compared against this window must go through normalizeAgainstOpen
// below so it lands on the same extended scale.
function getHoursWindow(now) {
  const hours = getHoursForDay(now);
  const openMin = timeStringToMinutes(hours.open);
  let closeMin = timeStringToMinutes(hours.close);
  if (closeMin <= openMin) {
    closeMin += 24 * 60;
  }
  return { openMin, closeMin };
}

// A raw minute-of-day (0-1439) that falls before today's open time could actually be in
// the overnight tail of a window that started yesterday (e.g. 1am with 5am-2am hours is
// still "open", just past midnight) - shifting it a full day forward puts it on the same
// scale as the extended closeMin from getHoursWindow so the comparison works either way.
function normalizeAgainstOpen(rawMin, openMin) {
  return rawMin < openMin ? rawMin + 24 * 60 : rawMin;
}

function validateOrderTiming(orderType, pickupTimeStr) {
  // Dev-only override for testing outside real café hours — never set in committed
  // config, .env is gitignored. Remove this env var to restore normal hours enforcement.
  if (process.env.DISABLE_HOURS_CHECK === 'true') {
    return { ok: true };
  }

  // Dev-only override for the opposite case — forces every hours check to report closed,
  // regardless of the actual time. Lets the "closed" flow (both the upfront check and the
  // pickup-time-specific one) be retested on demand instead of only during the real
  // closed window. Never set in committed config, .env is gitignored.
  if (process.env.FORCE_HOURS_CLOSED === 'true') {
    return { error: `Sorry, we're closed right now (testing override) — we'd normally open at ${getNextOpeningLabel(new Date())}.` };
  }

  const now = new Date();
  const { openMin, closeMin } = getHoursWindow(now);
  const cutoffMin = closeMin - CLOSING_BUFFER_MINUTES;

  // Delivery, or pickup with no specific time yet: validate against the current moment.
  // New orders stop being accepted once we're within the closing buffer.
  if (orderType === 'delivery' || !pickupTimeStr) {
    const rawNowMin = now.getHours() * 60 + now.getMinutes();
    const nowMin = normalizeAgainstOpen(rawNowMin, openMin);
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
  const rawTargetMin = parsed === 'now' ? now.getHours() * 60 + now.getMinutes() : parsed;
  const targetMin = normalizeAgainstOpen(rawTargetMin, openMin);
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
  const phoneDigits = String(input.phone_number).replace(/\D/g, '');
  const isValidPhone = phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits.startsWith('1'));
  if (!isValidPhone) {
    return { error: `"${input.phone_number}" doesn't look like a complete phone number — please provide a 10-digit number (or 11 digits starting with 1).` };
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

function generateOrderId() {
  return `2TRY1T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function confirmOrder(session) {
  if (session.cart.length === 0) {
    return { error: 'The cart is empty — add at least one item before confirming.' };
  }
  if (session.order.type !== 'pickup' && session.order.type !== 'delivery') {
    return { error: 'Order type (pickup or delivery) must be set before confirming.' };
  }
  if (session.order.type === 'pickup' && (!session.order.customerName || !session.order.pickupTime)) {
    return { error: 'A customer name and pickup time must be set before confirming a pickup order.' };
  }
  if (session.order.type === 'delivery' && !session.order.deliveryAddress) {
    return { error: 'A delivery address must be set before confirming a delivery order.' };
  }

  session.order.confirmed = true;
  session.order.confirmedAt = new Date().toISOString();
  session.order.orderId = generateOrderId();

  return {
    success: true,
    order: session.order,
    cart: cartSummary(session.cart),
    // Sourced from the same server-side calculation as check_promotions — never
    // trust the model's own arithmetic for the final discounted total.
    promotions: checkPromotions(session.cart)
  };
}

// Once an order is confirmed, its cart/order details are locked — no further mutation.
const MUTATING_TOOLS = new Set([
  'add_to_cart',
  'remove_from_cart',
  'update_customization',
  'set_order_type',
  'set_delivery_address',
  'confirm_order'
]);

function executeTool(toolName, input, session) {
  if (session.order.confirmed && MUTATING_TOOLS.has(toolName)) {
    return { error: `This order (${session.order.orderId}) is already placed and can't be changed. Please start a new conversation for another order.` };
  }

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
    case 'confirm_order':
      return confirmOrder(session);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Never changes at runtime — computed once so its bytes are identical across every
// request, which is what lets the cache breakpoint below actually hit. Text chat and
// voice calls use different base prompts (voice needs spoken-conversation rules the
// browser chat doesn't), so each gets its own stable block and its own cache breakpoint.
const STABLE_SYSTEM_TEXT = `${basePrompt}\n\n## Today's Menu (JSON)\n${JSON.stringify(menu, null, 2)}`;
const STABLE_SYSTEM_TEXT_VOICE = `${voiceBasePrompt}\n\n## Today's Menu (JSON)\n${JSON.stringify(menu, null, 2)}`;

function buildSystemBlocks(stableText, { resumedOrder = false } = {}) {
  const now = new Date();
  const nowLabel = `${DAY_NAMES[now.getDay()]}, ${formatClock(now.getHours() * 60 + now.getMinutes())}`;

  let timeText = `## Current Date & Time\nIt is currently **${nowLabel}**. This is the ground truth for "now" — use it to resolve relative times (e.g. "in 20 minutes", "this afternoon"). Never guess or claim you don't know the time.`;

  // Dev-only: when the server-side hours check is bypassed (see DISABLE_HOURS_CHECK in
  // validateOrderTiming), tell the model explicitly rather than letting it reason on its
  // own from the stated hours + current time above and proactively refuse orders that
  // set_order_type would actually accept — the two would otherwise disagree.
  if (process.env.DISABLE_HOURS_CHECK === 'true') {
    timeText += `\n\n**Testing note:** operating-hours enforcement is temporarily disabled for development testing. Do not decline or warn about an order being outside café hours for any reason — proceed normally and let set_order_type run as usual.`;
  }

  // A dropped call was already restored into the cart/order tools before this turn (see
  // /voice/incoming in voice-order-recovery.js) and the caller already heard a "welcome
  // back" greeting about it - but that greeting was spoken directly by Twilio, never
  // added to conversation history, so without this note the model's history is blank and
  // it has no way to know the greeting happened or that the cart isn't actually empty.
  if (resumedOrder) {
    timeText += `\n\n**Resumed call:** This caller just heard a greeting saying their order from a dropped call was restored. The cart and order tools already reflect that saved state right now — call \`view_cart\` before responding to their first message so you can speak to what's actually there, instead of assuming the cart is empty.`;
  }

  return [
    // Stable block first, with the cache breakpoint — identical bytes on every request,
    // so this (plus the tools array, which caches alongside the last system block) gets
    // served from cache at ~0.1x cost instead of being repriced in full every call.
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
    // Volatile block after the breakpoint — changes every minute, but since it comes
    // after the cached block it doesn't invalidate the cache, it just isn't cached itself.
    { type: 'text', text: timeText }
  ];
}

// Conversation history grows every turn but is otherwise sent byte-for-byte identical
// to the previous call's history plus one increment (a user message, or a tool round's
// assistant+tool_result pair) — an ideal shape for prompt caching. This returns a copy
// with a cache breakpoint on the last message's last content block, without mutating the
// stored history (only this outgoing request should carry the marker at this position;
// the next call will place a fresh one further along). Anthropic resolves the breakpoint
// against whatever prefix is already cached from the previous call, so everything before
// the newest increment is served from cache instead of repriced in full every turn.
function withCacheBreakpoint(messages) {
  if (messages.length === 0) {
    return messages;
  }
  const last = messages[messages.length - 1];
  const content = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : last.content;
  const markedContent = content.map((block, i) =>
    i === content.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
  );
  return [...messages.slice(0, -1), { ...last, content: markedContent }];
}

// Visibility into prompt caching per API call, so a caching regression (e.g. a future
// edit that breaks the cache breakpoint) shows up immediately in the server logs instead
// of only as a surprise on the Anthropic bill.
function logCacheUsage(usage) {
  if (!usage) {
    return;
  }
  console.log(
    `[anthropic usage] input=${usage.input_tokens} ` +
    `cache_read=${usage.cache_read_input_tokens || 0} ` +
    `cache_write=${usage.cache_creation_input_tokens || 0} ` +
    `output=${usage.output_tokens}`
  );
}

// Ensures a session-shaped object (browser session or voice call session) has the
// fields CafeBot's logic expects, regardless of which transport it came from.
function initSessionState(state) {
  if (!state.history) {
    state.history = [];
  }
  if (!state.cart) {
    state.cart = [];
  }
  if (!state.order) {
    state.order = {
      type: null,
      deliveryAddress: null,
      customerName: null,
      pickupTime: null,
      confirmed: false,
      confirmedAt: null,
      orderId: null
    };
  }
}

// Runs one turn of CafeBot's tool-use loop against a session-shaped state object and
// returns the same {reply, cart, order, promotions} shape /chat has always returned.
// Shared by /chat (browser, cookie session) and the voice routes (phone call, keyed by
// CallSid) so both transports go through identical tools and cart/order logic — only
// the system prompt (stableSystemText) differs, since voice needs spoken-conversation rules.
async function runCafeBotTurn(state, userMessage, stableSystemText) {
  // Blank history with an already-populated cart can only happen on the first turn of a
  // resumed call (a genuinely fresh session always starts with an empty cart) - check
  // before pushing this turn's message so it only fires once, on that first turn.
  const resumedOrder = state.history.length === 0 && state.cart.length > 0;

  state.history.push({ role: 'user', content: userMessage });

  const systemBlocks = buildSystemBlocks(stableSystemText, { resumedOrder });

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: MAX_RESPONSE_TOKENS,
    system: systemBlocks,
    tools: TOOLS,
    messages: withCacheBreakpoint(state.history)
  });
  logCacheUsage(response.usage);

  let rounds = 0;
  while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
    state.history.push({ role: 'assistant', content: response.content });

    const toolResults = response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(executeTool(block.name, block.input, state))
      }));

    state.history.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: MAX_RESPONSE_TOKENS,
      system: systemBlocks,
      tools: TOOLS,
      messages: withCacheBreakpoint(state.history)
    });

    logCacheUsage(response.usage);
    rounds += 1;
  }

  // Pull out any text content. If the loop above exhausted MAX_TOOL_ROUNDS while
  // Claude still wanted to call tools, or the response otherwise has no usable text
  // (e.g. stop_reason "max_tokens" with only a thinking block), fall back to a plain
  // message instead of shipping an empty reply — and don't persist a response with
  // dangling tool_use blocks or no real content into history.
  const textFromResponse = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  let reply;
  if (response.stop_reason === 'tool_use' || !textFromResponse) {
    reply = "Sorry, I'm having trouble processing that — could you try rephrasing or breaking it into smaller steps?";
    state.history.push({ role: 'assistant', content: reply });
  } else {
    state.history.push({ role: 'assistant', content: response.content });
    reply = textFromResponse;
  }

  return {
    reply,
    cart: cartSummary(state.cart),
    order: state.order,
    promotions: checkPromotions(state.cart)
  };
}

// In-memory phone-call sessions, keyed by Twilio CallSid. A phone call has no cookie to
// carry a browser session id, so CallSid — unique per call, provided on every voice
// webhook — is the natural equivalent. Lives only as long as the server process; a
// restart drops any calls in progress, which is fine for dev/testing.
const voiceSessions = new Map();

function getVoiceSession(callSid) {
  if (!voiceSessions.has(callSid)) {
    voiceSessions.set(callSid, {});
  }
  const state = voiceSessions.get(callSid);
  initSessionState(state);
  return state;
}

// Warn early if Twilio credentials aren't configured — the /voice/incoming route
// can't validate incoming webhooks without TWILIO_AUTH_TOKEN, and would otherwise
// fail confusingly on the first real call instead of at startup.
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.warn('Warning: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — /voice/incoming will reject all requests.');
}

if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
  console.warn('Warning: ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set — voice replies will fall back to Twilio <Say>.');
}

if (process.env.DISABLE_HOURS_CHECK === 'true') {
  console.warn('Warning: DISABLE_HOURS_CHECK=true — café operating hours are NOT being enforced. Dev/testing only.');
}

if (process.env.FORCE_HOURS_CLOSED === 'true') {
  console.warn('Warning: FORCE_HOURS_CLOSED=true — every hours check will report closed. Dev/testing only.');
}

// Confirms an incoming request to /voice/incoming genuinely came from Twilio, by
// recomputing the X-Twilio-Signature header from the auth token, request URL, and
// posted params (Twilio's documented webhook validation scheme) and rejecting on mismatch.
function validateTwilioRequest(req, res, next) {
  const twilioSignature = req.headers['x-twilio-signature'];
  const requestUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const isValid = process.env.TWILIO_AUTH_TOKEN
    && twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, twilioSignature, requestUrl, req.body);

  if (!isValid) {
    console.error('Rejected /voice/incoming request: invalid or missing Twilio signature.');
    return res.status(403).type('text/plain').send('Invalid Twilio signature.');
  }
  next();
}

const app = express();

// Twilio's requests arrive through a reverse proxy (ngrok in dev, and typically a load
// balancer in production) that terminates TLS and forwards over plain HTTP. Without this,
// req.protocol reports "http" even for https requests, which breaks Twilio signature
// validation below (the signature is computed against the https:// URL Twilio actually called).
app.set('trust proxy', true);

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks POST form-encoded params
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true }
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// Clean-URL routes for the site's pages. express.static above already serves index.html
// at "/" via its own default index resolution (no route needed for Home), and would also
// still serve these files at their raw *.html paths since it's unconditional — these
// routes just give each page a path that doesn't expose the .html extension.
app.get('/order', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.get('/menu', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// Read-only menu data for the new Menu page (menu.js) to render client-side. menu.json is
// only ever read server-side otherwise (see the require at the top of this file) - this is
// the same parsed object, just exposed so the static Menu page doesn't have to hardcode a
// second copy of the menu that could drift from the source of truth.
app.get('/api/menu', (req, res) => {
  res.json(menu);
});

app.post('/chat', async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  if (!userMessage) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  initSessionState(req.session);

  try {
    const result = await runCafeBotTurn(req.session, userMessage, STABLE_SYSTEM_TEXT);
    res.json(result);
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(500).json({ error: 'Something went wrong talking to CafeBot. Please try again.' });
  }
});

// Reusable <Gather> block — every turn of the phone conversation (the opening prompt,
// and every re-prompt after CafeBot replies) waits for speech the same way.
// promptText is optional — mid-conversation turns pass nothing, since CafeBot's own
// reply (already spoken right before this) almost always ends with a natural follow-up
// question of its own, and repeating a generic "What else can I get for you?" on top of
// that every single turn read as robotic and redundant.
async function addGather(twiml, promptText, req, { cache = true, callSid } = {}) {
  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process-speech',
    method: 'POST',
    // Seconds of silence to wait for the caller to start speaking before giving up.
    // Twilio's default is 5s, which is too short — barely enough time to notice the
    // prompt finished, let alone decide what to say.
    timeout: 10,
    // How long to wait after the caller STOPS talking before deciding they're done —
    // a separate setting from `timeout` above. Started as 'auto' (Twilio's own
    // speech-end detection), but real-call testing showed it firing on well under a
    // second of silence — plenty for quick answers, but it cut callers off mid-thought
    // while pausing to recall or rephrase something longer, like a delivery address or
    // phone number, sending Claude a truncated transcript instead of the full one. A
    // fixed few seconds of silence tolerance (Twilio's own docs suggest this exact fix
    // for callers getting cut off early) trades a little responsiveness on short replies
    // for not chopping longer ones apart.
    speechTimeout: 3,
    // Without this, Twilio only calls `action` when it actually hears something (even a
    // low-confidence guess) — a caller who stays completely silent for the full `timeout`
    // just falls through to whatever TwiML verb comes next in this response, with no way
    // to tell "still thinking" apart from "hung up". Forcing the action call on every
    // timeout routes silence through /voice/process-speech's own silence-strike handling.
    actionOnEmptyResult: true
  });
  // No beep — <Gather input="speech"> starts listening as soon as this finishes
  // playing, unlike <Record>, so prompts shouldn't promise an audio cue that never comes.
  //
  // Nesting the prompt INSIDE <Gather> (rather than playing it as a separate verb
  // before an empty Gather) is what gives barge-in: Twilio starts its speech recognizer
  // the moment this verb begins, concurrently with the audio, and cuts the audio short
  // as soon as it detects the caller talking. A prompt played *before* a separate
  // <Gather> only starts being listened to once it's already finished — no barge-in.
  if (promptText) {
    await speak(gather, promptText, { req, cache, callSid });

    // Stamped so a later barge-in-cutoff check (see isBargeInCutoff in
    // /voice/process-speech) knows what was playing and roughly when it started — without
    // this, promptText is just a local parameter that's gone the moment this function
    // returns, with nothing to replay if noise cuts it short.
    if (callSid) {
      const state = getVoiceSession(callSid);
      state.lastPromptText = promptText;
      state.lastPromptPlayedAt = Date.now();
      state.lastPromptEstimatedDurationMs = estimateSpeechDurationMs(promptText);
      state.lastPromptCache = cache;
    }
  }
}

// The café's name is styled "2try1t" everywhere in the menu/prompt data, which reads
// fine as text in the browser chat, but Twilio's TTS reads it literally as characters
// and digits instead of the intended "to try it" pronunciation. Claude naturally
// writes the brand name that way since that's how it appears in its own context, so
// this swaps it right before speech — voice-only, doesn't touch what the model
// generates or what the browser chat displays.
function speakable(text) {
  return text.replace(/2try1t/gi, 'To Try It');
}

// Twilio calls this webhook when someone dials the café's number. Starts the same
// tool-use conversation /chat uses — see runCafeBotTurn — just reached by phone instead
// of the browser widget, with CallSid standing in for a browser session cookie.
app.post('/voice/incoming', validateTwilioRequest, async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const from = req.body.From;

  // If this caller had an order in progress from a recent dropped call, restore it into
  // the new call's session before the first turn — the cart/order tools are the source of
  // truth Claude relies on (see runCafeBotTurn), so seeding them here is enough for a
  // `view_cart` mid-call to see the resumed items, no conversation history needed.
  // Disclosing the AI assistant up front, in the one line guaranteed to run on every
  // call, rather than leaving it to Claude's own judgment mid-conversation — that was
  // inconsistent (sometimes disclosed, sometimes not) since nothing told it whether or
  // when to bring it up. Baking it into the cached greeting means it's said exactly
  // once, every call, deterministically.
  const resumable = findResumableOrder(from);
  let greeting = "Thanks for calling To Try It, you're speaking with our AI ordering assistant. What can I get started for you?";
  if (resumable) {
    const state = getVoiceSession(callSid);
    state.cart = resumable.cart;
    state.order = resumable.order;
    greeting = "Welcome back to To Try It, you're speaking with our AI ordering assistant — looks like you had an order in progress from a moment ago. Want to pick up where you left off, or start fresh?";
  }

  // Spelled phonetically for TTS — Twilio's <Say> reads "2try1t" literally as
  // characters/digits instead of the intended "to try it" pronunciation.
  await addGather(twiml, greeting, req, { callSid });

  // No fallback verb needed here — actionOnEmptyResult (set in addGather) means a total
  // silence timeout still POSTs to /voice/process-speech, same as any other turn.

  res.type('text/xml');
  res.send(twiml.toString());
});

// Bare farewells the caller says to end the call themselves. Matched either as the
// whole utterance, or as its trailing clause (see isFarewell below) - deliberately not
// a substring match anywhere in the sentence, so it can't misfire on something like
// "no thanks" or "nothing else", which are answers to a question, not a request to
// hang up.
const FAREWELL_PHRASES = new Set([
  'bye', 'bye bye', 'goodbye', 'good bye', 'see you', 'see ya', 'take care', 'have a good one'
]);

// Minimum Twilio speech-recognition confidence (its own 0–1 score, sent alongside every
// SpeechResult) required to trust a farewell match enough to hang up immediately. Without
// this, a low-confidence mis-transcription of unclear or non-English speech that happens
// to land exactly on a short phrase like "bye" would end the call the caller never meant
// to end. Below the threshold it falls through to a normal CafeBot turn instead, where the
// "unclear speech" prompt guidance asks the caller to repeat themselves.
//
// Originally 0.7, but live-call transcripts showed genuine farewells consistently scoring
// at or below that bar - "Thank you. Bye bye." came back at 0.62, and a "You too. Thank
// you. Bye. Bye." in an earlier call barely passed at 0.705 - so real goodbyes were falling
// through to a full Claude turn (plus its filler) as often as they were caught. Lowered to
// match BARGE_IN_RESUME_CONFIDENCE below, which already represents "trust this is likely
// real speech, not noise" for a similar purpose elsewhere in this file.
const FAREWELL_CONFIDENCE_THRESHOLD = 0.55;

// Nesting prompts inside <Gather> for barge-in (see addGather) means Twilio's speech
// recognizer is now listening for the entire time the agent is talking, not just during
// a quiet pause between turns — so background noise or a stray sound mid-reply can end
// the Gather with a low-confidence, likely-garbage transcript far more often than
// before. Running a full Claude turn (plus a fresh, uncached ElevenLabs generation) on
// that would waste an API call every time it happens, so anything below this bar gets a
// cheap, cached re-prompt instead of ever reaching runCafeBotTurn.
//
// This has swung both ways in live testing: 0.4 rejected real order attempts (nothing
// ever made it into the cart), 0.15 let enough noisy-room garbage through to Claude that
// it made the noisy-call experience worse, not better. There's no clean signal to split
// "real but imperfect speech" from "noise that happened to transcribe to something" —
// Twilio only gives us this one score — so this is a live-tuned middle ground, not a
// principled number. The console.warn below logs every rejected attempt's actual score,
// so the next round of real-call testing gives real data to retune this against instead
// of guessing again.
const MIN_SPEECH_CONFIDENCE = 0.28;

// Separate, higher bar used only to decide whether a SpeechResult that arrived DURING our
// own prompt's estimated playback window (see isBargeInCutoff in /voice/process-speech) is
// a genuine interruption versus background noise that happened to trip Twilio's barge-in
// listener. Deliberately not reusing MIN_SPEECH_CONFIDENCE — that threshold is tuned for
// normal order capture (a caller answering a question after the agent finished talking),
// a different situation with different odds of a low score being real speech.
const BARGE_IN_RESUME_CONFIDENCE = 0.55;

// A SpeechResult arriving this soon after a prompt starts playing is treated as noise
// regardless of confidence — a real interruption needs at least a moment for the caller to
// notice the prompt and start talking, so anything faster is far more likely a line
// click/echo right as playback begins than an actual word. Twilio's <Gather> has no native
// "don't arm barge-in yet" option, so this approximates it after the fact using timing.
const BARGE_IN_GRACE_MS = 500;

// Caps how many times in a row we'll silently replay the same interrupted prompt before
// saying something. Without this, a persistently noisy environment (a TV, a busy room)
// could keep tripping the barge-in-cutoff check forever, looping the same sentence and
// never actually telling the caller anything's wrong.
const MAX_BARGE_IN_NOISE_STRIKES = 3;

// Rough estimate of how long ElevenLabs' spoken output for `text` will take, used only to
// tell whether a SpeechResult could have arrived while that audio was still playing (see
// isBargeInCutoff below) — not exact, just enough to distinguish "this came back while our
// prompt was almost certainly still going" from "the caller waited for it to finish".
function estimateSpeechDurationMs(text) {
  const CHARS_PER_SECOND = 13; // rough natural-speech pace
  const MIN_DURATION_MS = 900; // floor for very short prompts, plus rough playback-start overhead
  return Math.max(MIN_DURATION_MS, Math.round((text.length / CHARS_PER_SECOND) * 1000));
}

// Plays immediately after the caller stops talking, while the real Claude turn (floor of
// 1.6-4.5s even with the redundant-round-trip fix already in) runs in the background - see
// pendingVoiceReplies and /voice/continue below. Each phrase is cached like any other
// static line (see elevenlabs-tts.js), so picking from a pool still costs no extra
// Claude/TTS work once every phrase has been generated once. A pool instead of one fixed
// line avoids it reading as repetitive/irritating on calls with several back-and-forths.
const FILLER_PHRASES = [
  'One sec.',
  'Let me check that.',
  'Just a moment.',
  'Give me a second.',
  'Checking that now.',
  'One moment please.'
];

// Picks a random filler phrase, avoiding repeating the exact same one twice in a row
// within the same call - tracked on the voice session state so it resets naturally per
// call (a fresh session has no lastFiller yet, so the first pick is unconstrained).
function pickFillerPhrase(state) {
  const choices = state.lastFiller
    ? FILLER_PHRASES.filter((phrase) => phrase !== state.lastFiller)
    : FILLER_PHRASES;
  const picked = choices[Math.floor(Math.random() * choices.length)];
  state.lastFiller = picked;
  return picked;
}

// Bridges /voice/process-speech (kicks off runCafeBotTurn but returns before it resolves,
// so the filler can play immediately) and /voice/continue (awaits the same promise once
// Twilio redirects back after the filler finishes). Keyed by CallSid like voiceSessions -
// entries are removed as soon as /voice/continue consumes them.
const pendingVoiceReplies = new Map();

function isFarewell(text, confidence) {
  const confidenceValue = parseFloat(confidence);
  if (!Number.isFinite(confidenceValue) || confidenceValue < FAREWELL_CONFIDENCE_THRESHOLD) {
    return false;
  }
  // Collapse all punctuation (not just trailing) so "Bye. Bye." and "bye," both
  // normalize the same way before matching.
  const normalized = text.toLowerCase().replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const phrase of FAREWELL_PHRASES) {
    // Whole-utterance match, or the utterance ends with the farewell phrase as its own
    // trailing clause - e.g. "no that's ok, bye" or "thank you, bye bye" - so a caller
    // tacking a goodbye onto a sentence still ends the call immediately instead of
    // falling through to a full (and here, irrelevant) Claude turn plus filler.
    // Word-boundary anchored via the leading space so it can't match a farewell word
    // embedded mid-sentence.
    if (normalized === phrase || normalized.endsWith(` ${phrase}`)) {
      return true;
    }
  }
  return false;
}

// How many consecutive silent timeouts (no speech captured at all — see
// actionOnEmptyResult in addGather) we tolerate before actually ending the call. Each
// one is a fresh 10s <Gather> timeout, so this is what separates "caller is thinking, or
// said 'hold on' and paused" from "caller hung up or walked away". Reset to 0 the moment
// real speech comes back in, so a later pause gets a full fresh grace period too.
const MAX_SILENCE_STRIKES = 2;

// Gentle, increasingly explicit re-prompts for each silent strike — reused verbatim
// across all calls, so these are cacheable static lines like the other stock phrases.
const SILENCE_REPROMPTS = [
  'Still there? Take your time.',
  "Just checking you're still with me — whenever you're ready."
];

// Twilio POSTs here with the transcribed text every time a <Gather> above completes —
// both the very first thing the caller says, and every reply after that, since the
// re-prompt below points back at this same route to keep the conversation looping.
app.post('/voice/process-speech', validateTwilioRequest, async (req, res) => {
  const twiml = new VoiceResponse();
  const speechResult = req.body.SpeechResult;
  const callSid = req.body.CallSid;
  const from = req.body.From;

  // Diagnostic only, no behavior change - logs every turn's raw transcript and
  // confidence (not just guard failures, unlike the existing "confidence guard" log
  // below) so a live-watched test call can show exactly what was heard and where a
  // "please repeat" reply landed, instead of only the pass/fail outcome.
  console.log(`[speech] confidence=${req.body.Confidence || 'n/a'} transcript="${speechResult || ''}"`);

  if (!speechResult) {
    const state = getVoiceSession(callSid);
    state.silenceStrikes = (state.silenceStrikes || 0) + 1;

    if (state.silenceStrikes > MAX_SILENCE_STRIKES) {
      await speak(twiml, "I haven't heard back, so I'll go ahead and end the call here. Feel free to call again whenever you're ready. Goodbye!", { req, cache: true });
      voiceSessions.delete(callSid);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const repromptText = SILENCE_REPROMPTS[state.silenceStrikes - 1] || SILENCE_REPROMPTS[SILENCE_REPROMPTS.length - 1];
    await addGather(twiml, repromptText, req, { callSid });
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Handled before Claude ever sees it - a bare "bye" ends the call immediately instead
  // of going through a full model turn - but only when that's actually safe: if there's
  // an unconfirmed order sitting in the cart, this canned line would end the call
  // without ever telling the customer their order wasn't placed. In that case fall
  // through to the normal model turn instead, so Claude can respond per the "Ending the
  // Call" prompt rules (still a natural goodbye, but aware of the real order state).
  const existingState = voiceSessions.get(callSid);
  const state = getVoiceSession(callSid);

  // Real speech came back in, so the caller wasn't gone — just paused. Give the next
  // silence its own full grace period rather than picking up where this one left off.
  if (existingState) {
    existingState.silenceStrikes = 0;
  }

  const speechConfidence = parseFloat(req.body.Confidence);

  // Distinguishes "this SpeechResult arrived while our own prompt was still (or almost
  // certainly still) playing" — a barge-in cutoff — from "the caller waited for the prompt
  // to finish, then answered normally". Twilio's webhook doesn't expose this directly, so
  // it's approximated from timing: addGather stamps lastPromptPlayedAt/
  // lastPromptEstimatedDurationMs every time a prompt is spoken, and if this result came
  // back sooner than that estimated duration, our audio was almost certainly still going.
  const elapsedSincePrompt = state.lastPromptPlayedAt ? Date.now() - state.lastPromptPlayedAt : null;
  const isBargeInCutoff = elapsedSincePrompt !== null && elapsedSincePrompt < (state.lastPromptEstimatedDurationMs || 0);

  if (isBargeInCutoff) {
    const withinGraceWindow = elapsedSincePrompt < BARGE_IN_GRACE_MS;
    const belowResumeConfidence = !Number.isFinite(speechConfidence) || speechConfidence < BARGE_IN_RESUME_CONFIDENCE;

    if (withinGraceWindow || belowResumeConfidence) {
      state.bargeInNoiseStrikes = (state.bargeInNoiseStrikes || 0) + 1;

      if (state.bargeInNoiseStrikes <= MAX_BARGE_IN_NOISE_STRIKES) {
        console.warn(
          `Barge-in cutoff treated as noise (elapsed=${elapsedSincePrompt}ms of ~${state.lastPromptEstimatedDurationMs}ms estimated` +
          `${withinGraceWindow ? ', within grace window' : ''}, confidence=${Number.isFinite(speechConfidence) ? speechConfidence.toFixed(2) : 'n/a'} ` +
          `< ${BARGE_IN_RESUME_CONFIDENCE}): "${speechResult}" — replaying "${state.lastPromptText}"`
        );
        await addGather(twiml, state.lastPromptText, req, { cache: state.lastPromptCache, callSid });
        res.type('text/xml');
        return res.send(twiml.toString());
      }
      console.warn(`Barge-in noise strikes exceeded (${state.bargeInNoiseStrikes}) — falling back to normal reprompt.`);
    }
  }
  state.bargeInNoiseStrikes = 0;

  // See MIN_SPEECH_CONFIDENCE above — filters out low-confidence speech for turns that
  // weren't a barge-in cutoff (the case above already handled that one), same as before.
  if (Number.isFinite(speechConfidence) && speechConfidence < MIN_SPEECH_CONFIDENCE) {
    console.warn(`Speech below confidence guard (${speechConfidence.toFixed(2)} < ${MIN_SPEECH_CONFIDENCE}): "${speechResult}"`);
    await addGather(twiml, "Sorry, I didn't quite catch that — go ahead.", req, { callSid });
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const hasUnconfirmedOrder = !!existingState && existingState.cart.length > 0 && !existingState.order.confirmed;

  if (isFarewell(speechResult, req.body.Confidence) && !hasUnconfirmedOrder) {
    // hasUnconfirmedOrder is false here, so there's nothing genuinely in progress — but
    // clear anyway in case this call had resumed an older saved order and is now done.
    clearInProgressOrder(from);
    await speak(twiml, 'Thanks for calling To Try It, goodbye!', { req, cache: true });
    voiceSessions.delete(callSid);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const claudeStartedAt = Date.now();

  // Kick off the real turn now but don't await it here - the caller already waited
  // through the whole silence-confirmation window, and Claude's own floor is 1.6-4.5s on
  // top of that. Respond immediately with a short filler instead, so the wait is
  // acknowledged instead of silent; /voice/continue picks this same in-flight promise back
  // up once Twilio finishes playing the filler and redirects back. Starting the call here
  // (rather than after the filler plays) means the filler doesn't add to the real wait —
  // it just fills time that was going to pass anyway.
  const turnPromise = runCafeBotTurn(state, speechResult, STABLE_SYSTEM_TEXT_VOICE)
    .then((result) => ({ replyText: speakable(result.reply), cacheReply: false }))
    .catch((err) => {
      console.error('Anthropic API error (voice):', err);
      return { replyText: "Sorry, I'm having trouble right now. Please try again in a moment.", cacheReply: true };
    });
  pendingVoiceReplies.set(callSid, { turnPromise, state, from, claudeStartedAt });

  // No <Gather> here on purpose - this is a brief acknowledgment, not a real prompt, so
  // there's nothing useful to listen for yet. That means barge-in is unavailable for this
  // ~1s stretch, unlike every other prompt in this app; an acceptable trade given how short
  // it is.
  await speak(twiml, pickFillerPhrase(state), { req, cache: true });
  twiml.redirect({ method: 'POST' }, '/voice/continue');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Twilio hits this once the filler audio from /voice/process-speech finishes playing (see
// FILLER_TEXT / pendingVoiceReplies there). By the time this request lands, the Claude call
// kicked off there has usually already finished or is about to, since it's been running the
// whole time the filler played plus this redirect's own round-trip - so this is mostly just
// picking up the result and speaking it, not adding a second wait on top of the filler.
app.post('/voice/continue', validateTwilioRequest, async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;

  const pending = pendingVoiceReplies.get(callSid);
  if (!pending) {
    // Shouldn't normally happen — this route is only ever reached via our own <Redirect>
    // right after storing the pending promise. Re-prompt rather than erroring out the call
    // on a stray/duplicate hit.
    await addGather(twiml, "Sorry, could you say that again?", req, { callSid });
    res.type('text/xml');
    return res.send(twiml.toString());
  }
  pendingVoiceReplies.delete(callSid);

  const { turnPromise, state, from, claudeStartedAt } = pending;
  const { replyText, cacheReply } = await turnPromise;

  // Pairs with the [speech] log in /voice/process-speech - same diagnostic purpose, so a
  // "please repeat" reply can be matched back to exactly what was heard and its confidence.
  console.log(`[reply] "${replyText}"`);
  // Rough per-turn latency breakdown (Claude here, ElevenLabs generation logged separately
  // inside addGather/speak) - measured from when speech was confirmed, same as before the
  // filler was added, so this number is still comparable across both.
  console.log(`[latency] Claude turn: ${Date.now() - claudeStartedAt}ms`);

  // Write-through after every turn, not just on hangup — there's no Twilio status
  // callback wired up to tell this app when a call actually drops, so this is what
  // guarantees a dropped call never loses more than the current exchange. See
  // voice-order-recovery.js.
  if (state.order.confirmed || state.cart.length === 0) {
    clearInProgressOrder(from);
  } else {
    saveInProgressOrder({ from, callSid, cart: state.cart, order: state.order });
  }

  // Loop back into another <Gather> so the call keeps going instead of ending after
  // one exchange — this is what turns it into a real back-and-forth conversation.
  // CafeBot's reply is the Gather's own nested prompt (not a separate <Play> before
  // it) so the caller can barge in over it, same as every other turn.
  await addGather(twiml, replyText, req, { cache: cacheReply, callSid });

  // No fallback verb needed here — actionOnEmptyResult (set in addGather) means a
  // silence timeout on this gather still POSTs back to /voice/process-speech, where the
  // `if (!speechResult)` branch above handles it on that future request.

  res.type('text/xml');
  res.send(twiml.toString());
});

// Dev-only: exercises system-prompt-voice.md over plain text, the same way /chat
// exercises system-prompt.md. Lets voice-prompt changes (e.g. the Ending the Call /
// Cart Updates rules) be tested with curl instead of a real phone call - /chat can't be
// used for this since it always loads the browser prompt, not the voice one. Keeps its
// own history under req.session.voiceTest so it never collides with a real /chat session.
app.post('/dev/voice-chat', async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  if (!userMessage) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  if (!req.session.voiceTest) {
    req.session.voiceTest = {};
  }
  initSessionState(req.session.voiceTest);

  try {
    const result = await runCafeBotTurn(req.session.voiceTest, userMessage, STABLE_SYSTEM_TEXT_VOICE);
    res.json(result);
  } catch (err) {
    console.error('Anthropic API error (voice dev test):', err);
    res.status(500).json({ error: 'Something went wrong talking to CafeBot. Please try again.' });
  }
});

app.post('/reset', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
      return res.status(500).json({ error: 'Could not start a new conversation. Please try again.' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`2try1t CafeBot listening on http://localhost:${PORT}`);
});
