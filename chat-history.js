// D7: keeps a browser chat's stored conversation history bounded (see docs/inventory-plan.md).
//
// The history lives in the customer session and grows by one message per user turn plus two
// per tool round, so a very long chat would otherwise grow without limit in memory and in
// what every request sends to the model.
//
// Trimming only ever cuts at the start of a turn: a plain user message (text the customer
// typed, never a tool_result). Everything in a turn (the assistant's tool_use blocks, the
// user tool_result message that answers them, the final reply) is kept or dropped together,
// so a tool call is never separated from its result and the kept history always starts on
// a plain user message, which is what the Messages API expects. Only the history changes;
// the cart and order live in their own fields and are never touched.
//
// Prompt caching: tools and system blocks come first in the cached prefix and are not
// affected. Trimming changes the start of the message list, so the request after a trim
// writes the shorter history to the cache once, then later requests read it again. That is
// why the history is cut well below the cap (to TRIM_TARGET) instead of just under it: a cut
// happens about once every 20 messages, not on every turn after the cap is reached.

const HISTORY_MAX_MESSAGES = 60;
const HISTORY_TRIM_TARGET = 40;

function isPlainUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  return Array.isArray(message.content) && !message.content.some((block) => block && block.type === 'tool_result');
}

// Returns the history unchanged (the same array) while it has at most `max` messages.
// Otherwise returns a new array: the shortest run of whole turns from the end that has at
// most `target` messages, or just the newest turn if that turn alone is longer. A history
// with no turn start at all (never produced by /chat) is returned unchanged.
function trimHistory(history, { max = HISTORY_MAX_MESSAGES, target = HISTORY_TRIM_TARGET } = {}) {
  if (!Array.isArray(history) || history.length <= max) return history;

  let lastStart = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (!isPlainUserMessage(history[i])) continue;
    lastStart = i;
    if (history.length - i <= target) return history.slice(i);
  }
  return lastStart === -1 ? history : history.slice(lastStart);
}

module.exports = { trimHistory, isPlainUserMessage, HISTORY_MAX_MESSAGES, HISTORY_TRIM_TARGET };
