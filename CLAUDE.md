# Grocery Automation System

## What This Project Is
A phone-first weekly grocery ordering system for my family. Every Sunday I pick recipes on my phone, review the ingredient list, and the system places a Whole Foods delivery order via browser automation.

## How It Works (Architecture)
- **Phone (Safari):** A mobile web app served over local Wi-Fi. Home screen bookmark called "Groceries." This is the only interface I use day-to-day.
- **Mac (Express.js server):** Runs on port 3456. Serves the web app, pulls Cozi list, triggers browser ordering.
- **Chrome + Claude in Chrome:** Handles Whole Foods ordering. Navigates Amazon/Whole Foods, searches items, adds to cart, reads delivery slots. Uses my logged-in Amazon session.
- **Cozi MCP Server / py-cozi:** Pulls my family's running shopping list from the Cozi app.
- **Claude API:** Only AI piece that runs at order-time is Claude in Chrome.

## Key Files
- `recipes/recipes.json` — Master recipe collection (structured JSON)
- `config/secrets.json` — Cozi credentials, API keys (NEVER commit this)
- `config/ingredient-map.json` — Maps recipe ingredient names → Whole Foods search terms
- `config/pantry-staples.json` — Items I always have (auto-unchecked)
- `orders/` — Order history by date
- `src/recipe-server.js` — Express.js server (web app + API)
- `src/cozi-pull.js` — Fetches Cozi shopping list
- `src/order-placer.js` — Claude in Chrome ordering automation

## Sunday Flow (User Perspective)
1. Open "Groceries" on phone
2. Pick 4-5 recipes (tap to select)
3. Review merged ingredient list + Cozi items (uncheck what I have)
4. Tap "Place Order" — browser automation runs on Mac
5. Phone shows real-time progress
6. Review substitutions, pick delivery slot
7. Confirm → order placed → Cozi items marked done

## Recipe JSON Structure
```json
{
  "name": "Recipe Name",
  "servings": 4,
  "tags": ["weeknight", "easy", "kid-friendly"],
  "source": "google-doc",
  "ingredients": [
    {
      "name": "chicken breast",
      "qty": 1.5,
      "unit": "lb",
      "category": "meat",
      "search_term": "organic boneless skinless chicken breast"
    }
  ],
  "steps": ["Step 1", "Step 2"]
}
```

## My Setup
- Mac (stays open on Sundays)
- Claude Max subscription ($100/mo)
- Claude in Chrome extension installed
- Chrome logged into Amazon with Whole Foods delivery configured
- Amazon Prime member
- iPhone (Safari for the web app)
- Cozi app for family shopping lists

## My Skill Level
- I can copy-paste terminal commands and follow instructions
- I'm NOT a developer — explain things simply
- Keep terminal commands minimal and tell me what each one does
- If something needs troubleshooting, walk me through it step by step

## Preferences
- Mobile-first design — big tap targets, clean, minimal
- Never auto-place an order without my confirmation
- Always pause for cart review before checkout
- Keep all credentials in config/secrets.json, never hardcoded
- Add config/secrets.json to .gitignore immediately
- Use console.log for progress messages so I can see what's happening
- When something fails, give me a clear error message, not a stack trace
