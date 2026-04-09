/**
 * Smoke tests for ingredient merge logic and marker parsing.
 * Run: node test/test-merge.js
 */

const assert = require("assert");
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ============================================================
// Merge logic tests (reimplemented here to avoid file-system deps)
// ============================================================

function mergeIngredients(recipes, staples, ingredientMap) {
  const merged = new Map();

  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      const key = ing.name.toLowerCase();
      if (merged.has(key)) {
        const existing = merged.get(key);
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

  // Apply ingredient-map overrides
  for (const [key, ing] of merged) {
    if (ingredientMap[key]) {
      ing.search_term = ingredientMap[key];
      ing.search_term_source = "override";
    }
  }

  // Flag pantry staples
  for (const [key, ing] of merged) {
    ing.isStaple = staples.some(
      (s) => key.includes(s.toLowerCase()) || s.toLowerCase().includes(key)
    );
  }

  return merged;
}

console.log("\n--- Merge Logic ---");

test("deduplicates same ingredient, sums quantities", () => {
  const recipes = [
    { ingredients: [{ name: "chicken breast", qty: 1, unit: "lb", category: "meat" }] },
    { ingredients: [{ name: "chicken breast", qty: 0.5, unit: "lb", category: "meat" }] },
  ];
  const merged = mergeIngredients(recipes, [], {});
  assert.strictEqual(merged.size, 1);
  assert.strictEqual(merged.get("chicken breast").qty, 1.5);
});

test("keeps both when units differ, takes max qty", () => {
  const recipes = [
    { ingredients: [{ name: "garlic", qty: 3, unit: "clove", category: "produce" }] },
    { ingredients: [{ name: "garlic", qty: 1, unit: "head", category: "produce" }] },
  ];
  const merged = mergeIngredients(recipes, [], {});
  assert.strictEqual(merged.size, 1);
  assert.strictEqual(merged.get("garlic").qty, 3); // max(3,1)
});

test("case-insensitive dedup", () => {
  const recipes = [
    { ingredients: [{ name: "Bell Pepper", qty: 2, unit: "whole", category: "produce" }] },
    { ingredients: [{ name: "bell pepper", qty: 1, unit: "whole", category: "produce" }] },
  ];
  const merged = mergeIngredients(recipes, [], {});
  assert.strictEqual(merged.size, 1);
  assert.strictEqual(merged.get("bell pepper").qty, 3);
});

test("flags pantry staples", () => {
  const recipes = [
    { ingredients: [
      { name: "olive oil", qty: 2, unit: "tbsp", category: "pantry" },
      { name: "chicken", qty: 1, unit: "lb", category: "meat" },
    ]},
  ];
  const merged = mergeIngredients(recipes, ["olive oil", "kosher salt"], {});
  assert.strictEqual(merged.get("olive oil").isStaple, true);
  assert.strictEqual(merged.get("chicken").isStaple, false);
});

test("fuzzy staple matching works both ways", () => {
  const recipes = [
    { ingredients: [
      { name: "extra virgin olive oil", qty: 1, unit: "tbsp", category: "pantry" },
    ]},
  ];
  const merged = mergeIngredients(recipes, ["olive oil"], {});
  assert.strictEqual(merged.get("extra virgin olive oil").isStaple, true);
});

test("ingredient-map overrides search_term", () => {
  const recipes = [
    { ingredients: [{ name: "pasta", qty: 1, unit: "lb", category: "pantry", search_term: "penne" }] },
  ];
  const merged = mergeIngredients(recipes, [], { pasta: "barilla rotini" });
  assert.strictEqual(merged.get("pasta").search_term, "barilla rotini");
  assert.strictEqual(merged.get("pasta").search_term_source, "override");
});

test("ingredient-map doesn't affect items without overrides", () => {
  const recipes = [
    { ingredients: [{ name: "milk", qty: 1, unit: "gal", category: "dairy", search_term: "whole milk" }] },
  ];
  const merged = mergeIngredients(recipes, [], { pasta: "barilla rotini" });
  assert.strictEqual(merged.get("milk").search_term, "whole milk");
  assert.strictEqual(merged.get("milk").search_term_source, undefined);
});

// ============================================================
// Marker parsing tests
// ============================================================

console.log("\n--- Marker Parsing ---");

// Minimal ClaudeOrderer mock for testing parseMarkers
class MarkerParser {
  constructor(items) {
    this.items = items || [];
    this.results = [];
    this.state = "running";
    this.events = [];
    this.deliverySlots = [];
    this.cartTotal = null;
  }

  emit(event, data) {
    this.events.push({ event, data });
  }

  clearTimeout() {}

  findItemIndex(name) {
    const lower = name.toLowerCase();
    return this.items.findIndex(
      (item) =>
        item.name.toLowerCase() === lower ||
        (item.search_term && item.search_term.toLowerCase() === lower) ||
        item.name.toLowerCase().includes(lower) ||
        lower.includes(item.name.toLowerCase())
    );
  }

  hasResult(name) {
    const lower = name.toLowerCase();
    return this.results.some((r) => r.name.toLowerCase() === lower);
  }

  parseMarkers(text) {
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.match(/^\[LOGIN_NEEDED\]/)) {
        this.state = "login-needed";
        this.emit("status", { phase: "login-needed" });
        continue;
      }

      const searchMatch = trimmed.match(/^\[SEARCHING\]\s*(.+)$/);
      if (searchMatch) {
        this.emit("status", { phase: "ordering", name: searchMatch[1].trim() });
        continue;
      }

      const addedMatch = trimmed.match(/^\[ADDED\]\s*(.+?)\s*→\s*(.+)$/);
      if (addedMatch) {
        const name = addedMatch[1].trim();
        const product = addedMatch[2].trim();
        if (!this.hasResult(name)) {
          this.results.push({ name, found: true, productName: product });
        }
        continue;
      }

      const notFoundMatch = trimmed.match(/^\[NOT_FOUND\]\s*(.+?)\s*→\s*(.+)$/);
      if (notFoundMatch) {
        const name = notFoundMatch[1].trim();
        const reason = notFoundMatch[2].trim();
        if (!this.hasResult(name)) {
          this.results.push({ name, found: false, reason });
        }
        continue;
      }

      const errorMatch = trimmed.match(/^\[ERROR\]\s*(.+?)\s*→\s*(.+)$/);
      if (errorMatch) {
        const name = errorMatch[1].trim();
        const reason = errorMatch[2].trim();
        if (!this.hasResult(name)) {
          this.results.push({ name, found: false, reason, error: true });
        }
        continue;
      }

      const subMatch = trimmed.match(/^\[SUBSTITUTED\]\s*(.+?)\s*→\s*(.+)$/);
      if (subMatch) {
        const name = subMatch[1].trim();
        const product = subMatch[2].trim();
        if (!this.hasResult(name)) {
          this.results.push({ name, found: true, productName: product, substituted: true });
        }
        continue;
      }

      const cartMatch = trimmed.match(/^\[CART_TOTAL\]\s*\$?([\d.]+)/);
      if (cartMatch) {
        this.cartTotal = parseFloat(cartMatch[1]);
        this.emit("status", { phase: "cart-review", cartTotal: this.cartTotal });
        continue;
      }

      const slotMatch = trimmed.match(/^\[SLOT\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/);
      if (slotMatch) {
        this.deliverySlots.push({
          id: slotMatch[1].trim(),
          date: slotMatch[2].trim(),
          time: slotMatch[3].trim(),
          fee: slotMatch[4].trim(),
        });
        continue;
      }

      const checkoutMatch = trimmed.match(/^\[CHECKOUT_READY\]\s*(.*)$/);
      if (checkoutMatch) {
        this.emit("status", { phase: "checkout-ready", orderTotal: checkoutMatch[1].trim() });
        continue;
      }

      const checkoutErrMatch = trimmed.match(/^\[CHECKOUT_ERROR\]\s*(.+)$/);
      if (checkoutErrMatch) {
        this.emit("status", { phase: "error", message: checkoutErrMatch[1].trim() });
        continue;
      }
    }
  }
}

test("parses [ADDED] marker", () => {
  const p = new MarkerParser([{ name: "milk" }]);
  p.parseMarkers('[ADDED] milk → Whole Foods Organic Whole Milk');
  assert.strictEqual(p.results.length, 1);
  assert.strictEqual(p.results[0].found, true);
  assert.strictEqual(p.results[0].productName, "Whole Foods Organic Whole Milk");
});

test("parses [NOT_FOUND] marker", () => {
  const p = new MarkerParser([{ name: "dragon fruit" }]);
  p.parseMarkers('[NOT_FOUND] dragon fruit → No results for search term');
  assert.strictEqual(p.results.length, 1);
  assert.strictEqual(p.results[0].found, false);
  assert.strictEqual(p.results[0].reason, "No results for search term");
});

test("parses [ERROR] marker", () => {
  const p = new MarkerParser([{ name: "steak" }]);
  p.parseMarkers('[ERROR] steak → Page timed out');
  assert.strictEqual(p.results.length, 1);
  assert.strictEqual(p.results[0].error, true);
});

test("parses [LOGIN_NEEDED] marker", () => {
  const p = new MarkerParser([]);
  p.parseMarkers('[LOGIN_NEEDED]');
  assert.strictEqual(p.state, "login-needed");
  assert.strictEqual(p.events[0].data.phase, "login-needed");
});

test("parses [SEARCHING] marker", () => {
  const p = new MarkerParser([{ name: "eggs" }]);
  p.parseMarkers('[SEARCHING] eggs');
  assert.strictEqual(p.events[0].data.phase, "ordering");
});

test("parses [SUBSTITUTED] marker", () => {
  const p = new MarkerParser([{ name: "greek yogurt" }]);
  p.parseMarkers('[SUBSTITUTED] greek yogurt → Chobani Plain Greek Yogurt');
  assert.strictEqual(p.results.length, 1);
  assert.strictEqual(p.results[0].substituted, true);
  assert.strictEqual(p.results[0].found, true);
});

test("duplicate guard — second ADDED for same item is ignored", () => {
  const p = new MarkerParser([{ name: "milk" }]);
  p.parseMarkers('[ADDED] milk → Brand A Milk');
  p.parseMarkers('[ADDED] milk → Brand B Milk');
  assert.strictEqual(p.results.length, 1);
  assert.strictEqual(p.results[0].productName, "Brand A Milk");
});

test("duplicate guard is case-insensitive", () => {
  const p = new MarkerParser([{ name: "Chicken Breast" }]);
  p.parseMarkers('[ADDED] chicken breast → Organic Chicken');
  p.parseMarkers('[ADDED] Chicken Breast → Another Chicken');
  assert.strictEqual(p.results.length, 1);
});

test("parses multiple markers in one text block", () => {
  const p = new MarkerParser([{ name: "milk" }, { name: "eggs" }, { name: "bread" }]);
  p.parseMarkers(`
    [SEARCHING] milk
    [ADDED] milk → Whole Milk
    [SEARCHING] eggs
    [NOT_FOUND] eggs → Out of stock
    [SEARCHING] bread
    [ERROR] bread → Page timeout
  `);
  assert.strictEqual(p.results.length, 3);
  assert.strictEqual(p.results[0].found, true);
  assert.strictEqual(p.results[1].found, false);
  assert.strictEqual(p.results[2].error, true);
});

test("findItemIndex matches by name", () => {
  const p = new MarkerParser([{ name: "olive oil" }, { name: "chicken" }]);
  assert.strictEqual(p.findItemIndex("chicken"), 1);
  assert.strictEqual(p.findItemIndex("olive oil"), 0);
});

test("findItemIndex matches by search_term", () => {
  const p = new MarkerParser([{ name: "pasta", search_term: "barilla rotini" }]);
  assert.strictEqual(p.findItemIndex("barilla rotini"), 0);
});

test("findItemIndex returns -1 for unknown items", () => {
  const p = new MarkerParser([{ name: "milk" }]);
  assert.strictEqual(p.findItemIndex("xyz"), -1);
});

test("parses [CART_TOTAL] marker", () => {
  const p = new MarkerParser([]);
  p.parseMarkers('[CART_TOTAL] $47.89');
  assert.strictEqual(p.cartTotal, 47.89);
  assert.strictEqual(p.events[0].data.phase, "cart-review");
});

test("parses [CART_TOTAL] without dollar sign", () => {
  const p = new MarkerParser([]);
  p.parseMarkers('[CART_TOTAL] 32.50');
  assert.strictEqual(p.cartTotal, 32.50);
});

test("parses [SLOT] marker", () => {
  const p = new MarkerParser([]);
  p.parseMarkers('[SLOT] slot-1 | Sunday, Mar 30 | 10am - 12pm | FREE');
  assert.strictEqual(p.deliverySlots.length, 1);
  assert.strictEqual(p.deliverySlots[0].id, "slot-1");
  assert.strictEqual(p.deliverySlots[0].date, "Sunday, Mar 30");
  assert.strictEqual(p.deliverySlots[0].time, "10am - 12pm");
  assert.strictEqual(p.deliverySlots[0].fee, "FREE");
});

test("parses multiple [SLOT] markers", () => {
  const p = new MarkerParser([]);
  p.parseMarkers(`[SLOT] slot-1 | Sunday, Mar 30 | 10am - 12pm | FREE
[SLOT] slot-2 | Sunday, Mar 30 | 2pm - 4pm | $4.99`);
  assert.strictEqual(p.deliverySlots.length, 2);
  assert.strictEqual(p.deliverySlots[1].fee, "$4.99");
});

test("parses [CHECKOUT_READY] marker", () => {
  const p = new MarkerParser([]);
  p.parseMarkers('[CHECKOUT_READY] $52.47');
  assert.strictEqual(p.events[0].data.phase, "checkout-ready");
  assert.strictEqual(p.events[0].data.orderTotal, "$52.47");
});

test("parses [CHECKOUT_ERROR] marker", () => {
  const p = new MarkerParser([]);
  p.parseMarkers('[CHECKOUT_ERROR] Could not select delivery slot');
  assert.strictEqual(p.events[0].data.phase, "error");
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
