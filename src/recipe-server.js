const express = require("express");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { syncFromGoogleDoc, loadRecipes, loadPantryStaples } = require("./doc-sync");
const { getShoppingList, markItemsDone, resetClient } = require("./cozi-pull");
const { getClaudeOrderer } = require("./claude-orderer");
// Legacy Puppeteer orderer kept as fallback — switch with USE_CLAUDE_ORDERER=false
const { getOrderPlacer } = require("./order-placer");

const USE_CLAUDE = process.env.USE_CLAUDE_ORDERER !== "false";

const INGREDIENT_MAP_PATH = path.join(__dirname, "..", "config", "ingredient-map.json");

// Load ingredient search term overrides
function loadIngredientMap() {
  try {
    return JSON.parse(fs.readFileSync(INGREDIENT_MAP_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// Save ingredient search term overrides
function saveIngredientMap(map) {
  fs.writeFileSync(INGREDIENT_MAP_PATH, JSON.stringify(map, null, 2) + "\n");
}

// SSE clients listening for order updates
let sseClients = [];

const app = express();
const PORT = 3456;

const SECRETS_PATH = path.join(__dirname, "..", "config", "secrets.json");

// Serve the mobile web app from public/
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

// Load API key from secrets
function getApiKey() {
  const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
  return secrets.api_key;
}

// Auth middleware — checks X-API-Key header
function authCheck(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== getApiKey()) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// POST /sync — Pull latest recipes from Google Doc
app.post("/sync", authCheck, async (req, res) => {
  try {
    console.log("Syncing recipes from Google Doc...");
    const result = await syncFromGoogleDoc();
    console.log(result.message);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Sync error:", err.message);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

// GET /recipes — List all recipes (names, tags, ingredient count)
app.get("/recipes", authCheck, (req, res) => {
  try {
    const recipes = loadRecipes();
    const summary = recipes.map((r) => ({
      name: r.name,
      servings: r.servings,
      tags: r.tags,
      ingredientCount: r.ingredients.length,
      source: r.source,
    }));
    res.json({ count: recipes.length, recipes: summary });
  } catch (err) {
    res.status(500).json({ error: "Failed to load recipes", details: err.message });
  }
});

// GET /recipes/:name — Get full recipe details by name
app.get("/recipes/:name", authCheck, (req, res) => {
  try {
    const recipes = loadRecipes();
    const recipe = recipes.find(
      (r) => r.name.toLowerCase() === decodeURIComponent(req.params.name).toLowerCase()
    );
    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: "Failed to load recipe", details: err.message });
  }
});

// GET /cozi — Fetch Cozi shopping list items
app.get("/cozi", authCheck, async (req, res) => {
  try {
    const items = await getShoppingList();
    res.json({ items });
  } catch (err) {
    console.error("Cozi error:", err.message);
    // If auth failed, reset client so next request retries
    resetClient();
    res.status(500).json({ error: "Failed to fetch Cozi list", details: err.message });
  }
});

// POST /cozi/done — Mark Cozi items as completed after ordering
app.post("/cozi/done", authCheck, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Send { items: [{ itemId, listId }] }' });
    }
    const result = await markItemsDone(items);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Cozi mark-done error:", err.message);
    res.status(500).json({ error: "Failed to mark items done", details: err.message });
  }
});

// POST /merge — Merge ingredients from selected recipes
app.post("/merge", authCheck, async (req, res) => {
  try {
    const { recipes: selectedNames, includeCozi } = req.body;
    if (!Array.isArray(selectedNames) || selectedNames.length === 0) {
      return res.status(400).json({ error: "Send { recipes: [\"name1\", \"name2\"] }" });
    }

    const allRecipes = loadRecipes();
    const staples = loadPantryStaples();

    // Find the full recipe objects for selected names
    const selected = selectedNames.map((name) => {
      const recipe = allRecipes.find(
        (r) => r.name.toLowerCase() === name.toLowerCase()
      );
      if (!recipe) console.log(`Warning: recipe "${name}" not found, skipping`);
      return recipe;
    }).filter(Boolean);

    // Collect all ingredients and deduplicate
    const merged = new Map(); // key: lowercase name, value: ingredient object

    for (const recipe of selected) {
      for (const ing of recipe.ingredients) {
        const key = ing.name.toLowerCase();
        if (merged.has(key)) {
          const existing = merged.get(key);
          // Sum quantities if units match, otherwise keep the larger qty
          if (existing.unit === ing.unit) {
            existing.qty += ing.qty;
          } else {
            existing.qty = Math.max(existing.qty, ing.qty);
          }
        } else {
          merged.set(key, { ...ing, name: ing.name.toLowerCase() });
        }
      }
    }

    // Apply ingredient-map overrides (user-edited search terms)
    const ingredientMap = loadIngredientMap();
    for (const [key, ing] of merged) {
      if (ingredientMap[key]) {
        ing.search_term = ingredientMap[key];
        ing.search_term_source = "override";
      }
    }

    // Flag pantry staples (fuzzy match)
    for (const [key, ing] of merged) {
      ing.isStaple = staples.some(
        (s) => key.includes(s.toLowerCase()) || s.toLowerCase().includes(key)
      );
    }

    // Group by category
    const categoryOrder = [
      "produce", "meat", "seafood", "dairy", "bakery", "frozen", "pantry", "canned", "other",
    ];
    const groupMap = {};
    for (const ing of merged.values()) {
      const cat = ing.category || "other";
      if (!groupMap[cat]) groupMap[cat] = [];
      groupMap[cat].push(ing);
    }

    // Sort groups by category order, sort items within each group alphabetically
    const groups = categoryOrder
      .filter((cat) => groupMap[cat])
      .map((cat) => ({
        category: cat,
        items: groupMap[cat].sort((a, b) => a.name.localeCompare(b.name)),
      }));

    // Append Cozi shopping list items as their own group
    if (includeCozi) {
      try {
        const coziItems = await getShoppingList();
        if (coziItems.length > 0) {
          groups.unshift({
            category: "from cozi",
            items: coziItems.map((item) => {
              const coziKey = item.text.toLowerCase();
              const override = ingredientMap[coziKey];
              return {
                name: item.text,
                qty: null,
                unit: null,
                category: "from cozi",
                source: "cozi",
                itemId: item.itemId,
                listId: item.listId,
                isStaple: false,
                ...(override ? { search_term: override, search_term_source: "override" } : {}),
              };
            }),
          });
        }
      } catch (err) {
        console.error("Cozi fetch during merge failed:", err.message);
        // Continue without Cozi items — don't block the merge
      }
    }

    console.log(`Merged ${merged.size} ingredients from ${selected.length} recipes`);
    res.json({ groups });
  } catch (err) {
    console.error("Merge error:", err.message);
    res.status(500).json({ error: "Failed to merge ingredients", details: err.message });
  }
});

// GET /ingredient-map — get all search term overrides
app.get("/ingredient-map", authCheck, (req, res) => {
  res.json(loadIngredientMap());
});

// PUT /ingredient-map — update a single ingredient's search term
app.put("/ingredient-map", authCheck, (req, res) => {
  const { ingredient, search_term } = req.body;
  if (!ingredient || typeof ingredient !== "string") {
    return res.status(400).json({ error: "Send { ingredient: \"name\", search_term: \"term\" }" });
  }

  const map = loadIngredientMap();
  const key = ingredient.toLowerCase();

  if (!search_term || search_term.trim() === "") {
    // Empty search_term = remove override
    delete map[key];
    console.log(`Removed search term override for "${key}"`);
  } else {
    map[key] = search_term.trim();
    console.log(`Set search term for "${key}" → "${search_term.trim()}"`);
  }

  saveIngredientMap(map);
  res.json({ success: true, map });
});

// --- Order endpoints ---

// SSE stream for real-time order updates (uses query param for auth)
app.get("/order/events", (req, res) => {
  const key = req.query.key;
  if (!key || key !== getApiKey()) {
    return res.status(401).json({ error: "Invalid key" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n"); // SSE comment to keep connection alive

  sseClients.push(res);
  console.log(`SSE client connected (${sseClients.length} total)`);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
    console.log(`SSE client disconnected (${sseClients.length} total)`);
  });
});

// Broadcast an SSE event to all connected clients
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

// Get the active orderer (Claude Code or legacy Puppeteer)
function getActiveOrderer() {
  return USE_CLAUDE ? getClaudeOrderer() : getOrderPlacer();
}

// Wire up orderer events to SSE broadcast
function wireOrderEvents(orderer) {
  // Remove old listeners to avoid duplicates
  orderer.removeAllListeners("status");
  orderer.removeAllListeners("item");
  orderer.on("status", (data) => broadcast("status", data));
  orderer.on("item", (data) => broadcast("item", data));
}

// POST /order/start — begin adding items to Whole Foods cart
app.post("/order/start", authCheck, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Send { items: [{ name, search_term }] }' });
  }

  const orderer = getActiveOrderer();
  if (orderer.state === "running") {
    return res.status(409).json({ error: "An order is already in progress" });
  }

  const engine = USE_CLAUDE ? "claude-code" : "puppeteer";
  console.log(`Starting order with ${items.length} items using ${engine} engine`);

  wireOrderEvents(orderer);
  res.json({ success: true, message: `Starting order with ${items.length} items`, engine });

  // Start async — results stream via SSE
  orderer.startOrder(items);
});

// POST /order/continue — resume after Amazon login
app.post("/order/continue", authCheck, async (req, res) => {
  const orderer = getActiveOrderer();
  if (orderer.state !== "login-needed") {
    return res.status(400).json({ error: "No order waiting for login" });
  }

  wireOrderEvents(orderer);
  res.json({ success: true, message: "Continuing order..." });

  orderer.continueAfterLogin();
});

// POST /order/cancel — stop a running order
app.post("/order/cancel", authCheck, (req, res) => {
  const orderer = getActiveOrderer();
  if (orderer.state !== "running" && orderer.state !== "login-needed") {
    return res.status(400).json({ error: "No order in progress to cancel" });
  }

  console.log("Cancelling order...");
  if (typeof orderer.cancel === "function") {
    orderer.cancel("Order cancelled from phone.");
  } else {
    // Legacy Puppeteer orderer — close the browser
    orderer.close();
    orderer.state = "error";
    orderer.emit("status", { phase: "error", message: "Order cancelled." });
  }
  res.json({ success: true, message: "Order cancelled" });
});

// GET /order/status — poll current order state (fallback if SSE drops)
app.get("/order/status", authCheck, (req, res) => {
  const orderer = getActiveOrderer();
  res.json({
    state: orderer.state,
    itemsTotal: orderer.items.length,
    itemsDone: orderer.results.length,
    results: orderer.results,
    engine: USE_CLAUDE ? "claude-code" : "puppeteer",
  });
});

// Health check (no auth needed)
app.get("/health", (req, res) => {
  res.json({ status: "ok", recipes: loadRecipes().length });
});

// --- Order history ---

const ORDERS_DIR = path.join(__dirname, "..", "orders");

// GET /orders — list past orders (newest first)
app.get("/orders", authCheck, (req, res) => {
  if (!fs.existsSync(ORDERS_DIR)) {
    return res.json({ orders: [] });
  }

  const files = fs.readdirSync(ORDERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const orders = files.map((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), "utf-8"));
      return {
        filename: f,
        date: data.date,
        itemsRequested: data.itemsRequested || 0,
        itemsAdded: data.itemsAdded || 0,
        results: data.results || [],
        total: data.total || null,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  res.json({ orders });
});

// --- Cart review + checkout ---

// POST /order/checkout — tell Claude to proceed with checkout and pick a delivery slot
app.post("/order/checkout", authCheck, async (req, res) => {
  const orderer = getActiveOrderer();
  if (orderer.state !== "cart-ready") {
    return res.status(400).json({ error: "Cart is not ready for checkout" });
  }

  const { slotId } = req.body; // optional preferred slot
  console.log("Starting checkout phase...");
  wireOrderEvents(orderer);
  res.json({ success: true, message: "Starting checkout..." });

  orderer.startCheckout(slotId);
});

// --- Recipe URL parsing ---

// POST /recipes/import — extract recipe from a URL using Claude API
app.post("/recipes/import", authCheck, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Send { url: \"https://...\" }" });
  }

  try {
    console.log(`Importing recipe from: ${url}`);

    // Fetch the page content
    const pageRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    });
    if (!pageRes.ok) {
      return res.status(400).json({ error: `Could not fetch URL (${pageRes.status})` });
    }
    const html = await pageRes.text();

    // Strip HTML tags for a rough text extraction, keep it under ~8000 chars
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);

    // Use Claude API to extract structured recipe
    const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "secrets.json"), "utf-8"));
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: secrets.anthropic_api_key });

    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Extract the recipe from this web page text and return ONLY valid JSON (no markdown, no backticks) in this exact format:

{
  "name": "Recipe Name",
  "servings": 4,
  "tags": ["weeknight", "easy"],
  "source": "${url}",
  "ingredients": [
    {
      "name": "ingredient name (lowercase)",
      "qty": 1.5,
      "unit": "lb or cup or tbsp or tsp or oz or whole or clove or can",
      "category": "produce or meat or seafood or dairy or bakery or frozen or pantry or canned or other",
      "search_term": "what to search on Whole Foods (specific brand/type if mentioned)"
    }
  ],
  "steps": ["Step 1 text", "Step 2 text"]
}

Rules:
- Use lowercase for ingredient names
- "whole" as unit for items counted individually (e.g. 3 whole bell peppers)
- search_term should be more specific than name (e.g. name:"chicken breast" → search_term:"boneless skinless chicken breast")
- Keep tags simple: weeknight, easy, quick, kid-friendly, healthy, comfort, vegetarian, etc.
- If servings aren't specified, estimate based on the recipe

Page text:
${textContent}`,
        },
      ],
    });

    const responseText = msg.content[0].text;
    let recipe;
    try {
      recipe = JSON.parse(responseText);
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        recipe = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ error: "Could not parse recipe from Claude's response" });
      }
    }

    // Validate structure
    if (!recipe.name || !recipe.ingredients || !Array.isArray(recipe.ingredients)) {
      return res.status(500).json({ error: "Invalid recipe structure from Claude" });
    }

    res.json({ success: true, recipe });
  } catch (err) {
    console.error("Recipe import error:", err.message);
    res.status(500).json({ error: "Failed to import recipe: " + err.message });
  }
});

// POST /recipes/save — save an imported recipe to recipes.json
app.post("/recipes/save", authCheck, (req, res) => {
  const { recipe } = req.body;
  if (!recipe || !recipe.name || !recipe.ingredients) {
    return res.status(400).json({ error: "Invalid recipe data" });
  }

  const recipes = loadRecipes();

  // Check for duplicate name
  const existing = recipes.findIndex(
    (r) => r.name.toLowerCase() === recipe.name.toLowerCase()
  );
  if (existing >= 0) {
    recipes[existing] = recipe; // Update existing
    console.log(`Updated recipe: ${recipe.name}`);
  } else {
    recipes.push(recipe);
    console.log(`Added new recipe: ${recipe.name}`);
  }

  const recipesPath = path.join(__dirname, "..", "recipes", "recipes.json");
  fs.writeFileSync(recipesPath, JSON.stringify(recipes, null, 2));
  res.json({ success: true, total: recipes.length, updated: existing >= 0 });
});

// Start HTTPS server (Safari on iPhone forces https://)
const certDir = path.join(__dirname, "..", "config", "certs");
const sslOptions = {
  key: fs.readFileSync(path.join(certDir, "key.pem")),
  cert: fs.readFileSync(path.join(certDir, "cert.pem")),
};

https.createServer(sslOptions, app).listen(PORT, "0.0.0.0", () => {
  console.log(`Grocery server running on https://localhost:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /health          — Health check (no auth)`);
  console.log(`  GET  /recipes         — List all recipes`);
  console.log(`  GET  /recipes/:name   — Get recipe details`);
  console.log(`  POST /sync            — Sync recipes from Google Doc`);
  console.log(`  POST /merge           — Merge ingredients from selected recipes`);
  console.log(`  GET  /ingredient-map  — Get search term overrides`);
  console.log(`  PUT  /ingredient-map  — Set search term for an ingredient`);
  console.log(`  GET  /cozi            — Fetch Cozi shopping list`);
  console.log(`  POST /cozi/done       — Mark Cozi items as done`);
  console.log(`  POST /order/start     — Start adding items to Whole Foods cart`);
  console.log(`  POST /order/cancel    — Cancel a running order`);
  console.log(`  POST /order/continue  — Resume after Amazon login`);
  console.log(`  GET  /order/events    — Real-time order status (SSE)`);
  console.log(`  POST /order/checkout  — Proceed to checkout`);
  console.log(`  GET  /order/status    — Poll order state`);
  console.log(`  GET  /orders          — Order history`);
  console.log(`  POST /recipes/import  — Import recipe from URL`);
  console.log(`  POST /recipes/save    — Save imported recipe`);
  console.log(`  Engine: ${USE_CLAUDE ? "Claude Code" : "Puppeteer (legacy)"}`);
  console.log(`\nPhone: https://10.0.0.167:${PORT}`);
  console.log(`All endpoints except /health require X-API-Key header`);
});

// Clean up child processes on server shutdown
function cleanupOnExit() {
  const orderer = getActiveOrderer();
  if (typeof orderer.cleanup === "function") {
    orderer.cleanup();
  } else if (typeof orderer.close === "function") {
    orderer.close();
  }
}

process.on("SIGTERM", () => { cleanupOnExit(); process.exit(0); });
process.on("SIGINT", () => { cleanupOnExit(); process.exit(0); });
