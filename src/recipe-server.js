const express = require("express");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { syncFromGoogleDoc, loadRecipes, loadPantryStaples } = require("./doc-sync");
const { getShoppingList, markItemsDone, resetClient } = require("./cozi-pull");
const { getOrderPlacer } = require("./order-placer");

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
            items: coziItems.map((item) => ({
              name: item.text,
              qty: null,
              unit: null,
              category: "from cozi",
              source: "cozi",
              itemId: item.itemId,
              listId: item.listId,
              isStaple: false,
            })),
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

// Wire up OrderPlacer events to SSE broadcast
function wireOrderEvents(placer) {
  // Remove old listeners to avoid duplicates
  placer.removeAllListeners("status");
  placer.removeAllListeners("item");
  placer.on("status", (data) => broadcast("status", data));
  placer.on("item", (data) => broadcast("item", data));
}

// POST /order/start — begin adding items to Whole Foods cart
app.post("/order/start", authCheck, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Send { items: [{ name, search_term }] }' });
  }

  const placer = getOrderPlacer();
  if (placer.state === "running") {
    return res.status(409).json({ error: "An order is already in progress" });
  }

  wireOrderEvents(placer);
  res.json({ success: true, message: `Starting order with ${items.length} items` });

  // Start async — results stream via SSE
  placer.startOrder(items);
});

// POST /order/continue — resume after Amazon login
app.post("/order/continue", authCheck, async (req, res) => {
  const placer = getOrderPlacer();
  if (placer.state !== "login-needed") {
    return res.status(400).json({ error: "No order waiting for login" });
  }

  wireOrderEvents(placer);
  res.json({ success: true, message: "Continuing order..." });

  placer.continueAfterLogin();
});

// GET /order/status — poll current order state (fallback if SSE drops)
app.get("/order/status", authCheck, (req, res) => {
  const placer = getOrderPlacer();
  res.json({
    state: placer.state,
    itemsTotal: placer.items.length,
    itemsDone: placer.results.length,
    results: placer.results,
  });
});

// Health check (no auth needed)
app.get("/health", (req, res) => {
  res.json({ status: "ok", recipes: loadRecipes().length });
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
  console.log(`  GET  /cozi            — Fetch Cozi shopping list`);
  console.log(`  POST /cozi/done       — Mark Cozi items as done`);
  console.log(`  POST /order/start     — Start adding items to Whole Foods cart`);
  console.log(`  POST /order/continue  — Resume after Amazon login`);
  console.log(`  GET  /order/events    — Real-time order status (SSE)`);
  console.log(`  GET  /order/status    — Poll order state`);
  console.log(`\nPhone: https://10.0.0.167:${PORT}`);
  console.log(`All endpoints except /health require X-API-Key header`);
});
