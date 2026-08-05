# Milestone 1 — Project Scaffold (Instructions for Claude Code)

## Goal
Prove the basic chat pipe works end-to-end: user types a message in the browser → backend sends it to the Claude API → response displays back in the browser. No ordering logic, no tools, no cart yet.

## What to build

1. **Project setup**
   - Node.js + Express backend
   - Simple HTML/JS frontend (no framework needed — plain HTML/CSS/JS is fine)
   - `.env` file for the Claude API key (never hardcode the key)

2. **Sample menu data**
   - Create `menu.json` with ~15 café items for a café called **2try1t**
   - Each item should include: name, category, short description, price, available sizes (if applicable), available customizations, allergens
   - Cover a few categories (e.g., Coffee, Cold Drinks, Pastries, Sandwiches)

3. **Backend**
   - One API route (e.g., `POST /chat`) that:
     - Accepts a user message from the frontend
     - Sends it to the Claude API along with a simple system prompt (just: "You are CafeBot, a friendly assistant for 2try1t café. You can see today's menu below." + the menu.json contents)
     - Returns Claude's response to the frontend
   - Keep conversation history in memory per session for now (no database yet)

4. **Frontend**
   - A single chat page: text input, send button, message list showing user + assistant messages
   - Very basic styling is fine — functionality over polish at this stage

## What NOT to build yet
- No cart/tool use
- No order confirmation
- No address collection
- No promotions logic
- No database (menu.json and in-memory session state are enough)

## Definition of done
- You can open the page, type "What's on the menu?" or "Do you have iced coffee?", and get an accurate response based on `menu.json`.
- You can have a short back-and-forth conversation and the agent remembers earlier messages in the same session.
- Nothing crashes on a basic conversation.

## Suggested prompt to give Claude Code
> "Set up a basic project with a Node.js/Express backend and a simple HTML/JS frontend chat page. Create a sample menu.json with ~15 café items for a café called 2try1t (name, category, description, price, sizes, customizations, allergens). Wire up a basic chat: user sends a message, backend calls the Claude API with the message plus the menu as context, response displays in the browser. Keep conversation history in memory per session. No ordering logic yet — just prove the chat pipe works end-to-end."
