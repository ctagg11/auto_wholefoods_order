const fs = require("fs");
const path = require("path");

const RECIPES_PATH = path.join(__dirname, "..", "recipes", "recipes.json");
const SECRETS_PATH = path.join(__dirname, "..", "config", "secrets.json");
const STAPLES_PATH = path.join(__dirname, "..", "config", "pantry-staples.json");

const VALID_CATEGORIES = [
  "produce", "meat", "seafood", "dairy", "bakery", "frozen", "pantry", "canned", "other",
];

function loadSecrets() {
  return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
}

function loadRecipes() {
  if (!fs.existsSync(RECIPES_PATH)) return [];
  return JSON.parse(fs.readFileSync(RECIPES_PATH, "utf-8"));
}

function saveRecipes(recipes) {
  fs.writeFileSync(RECIPES_PATH, JSON.stringify(recipes, null, 2));
}

/**
 * Fetches a Google Doc as plain text. The doc must be shared as
 * "Anyone with the link can view" — no API key needed.
 */
async function fetchGoogleDoc(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  console.log("Fetching Google Doc...");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Google Doc (${res.status}). Make sure the doc is shared as "Anyone with the link can view".`
    );
  }

  const text = await res.text();
  console.log(`Fetched ${text.length} characters from Google Doc`);
  return text;
}

/**
 * Parses plain text from the Google Doc into recipe objects.
 *
 * Expected format in the doc:
 *
 *   # Recipe Name
 *   Servings: 4
 *   Tags: weeknight, easy, kid-friendly
 *
 *   ## Ingredients
 *   - 1.5 lb chicken breast [meat]
 *   - 3 bell peppers [produce]
 *   - 1 tbsp olive oil [pantry]
 *   - 1 pack flour tortillas [bakery] -> 365 flour tortillas
 *
 *   ## Steps
 *   1. Preheat oven to 400F
 *   2. Slice chicken and vegetables
 *   3. Toss with oil and spices, roast 25 min
 *
 *   ---
 *
 *   # Next Recipe Name
 *   ...
 */
function parseDocText(text) {
  // Split on recipe headers (# at start of line)
  const recipeBlocks = text.split(/^# /m).filter((b) => b.trim());
  const recipes = [];

  for (const block of recipeBlocks) {
    try {
      const recipe = parseSingleRecipe(block);
      if (recipe) recipes.push(recipe);
    } catch (err) {
      console.log(`Warning: skipped a recipe block — ${err.message}`);
    }
  }

  return recipes;
}

function parseSingleRecipe(block) {
  const lines = block.split("\n");

  // First line is the recipe name (after the # was split off)
  const name = lines[0].trim();
  if (!name) return null;

  // Parse servings
  const servingsLine = lines.find((l) => /^servings\s*:/i.test(l.trim()));
  const servings = servingsLine
    ? parseInt(servingsLine.replace(/^servings\s*:\s*/i, ""), 10) || 4
    : 4;

  // Parse tags
  const tagsLine = lines.find((l) => /^tags\s*:/i.test(l.trim()));
  const tags = tagsLine
    ? tagsLine.replace(/^tags\s*:\s*/i, "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];

  // Find steps section
  const stepsStart = lines.findIndex((l) => /^##\s*steps/i.test(l.trim()));

  // Find ingredients: either after "## Ingredients" header, or any line with [category]
  // before "## Steps". This handles both formats:
  //   - Formal: ## Ingredients / - 1 lb chicken [meat]
  //   - Casual: 1 lb chicken [meat]  (no header, no bullets)
  const ingStart = lines.findIndex((l) => /^##\s*ingredients/i.test(l.trim()));

  const ingredients = [];
  const ingStartIdx = ingStart !== -1 ? ingStart + 1 : 1; // skip recipe name line
  const ingEndIdx = stepsStart !== -1 ? stepsStart : lines.length;

  for (let i = ingStartIdx; i < ingEndIdx; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("##") || line === "---") continue;
    // Skip metadata lines like "Servings:" or "Tags:"
    if (/^(servings|tags)\s*:/i.test(line)) continue;

    // Strip optional bullet points
    line = line.replace(/^[-*]\s*/, "");

    // If line has a [category] bracket, treat it as an ingredient
    if (/\[\w+\]/.test(line)) {
      const ing = parseIngredientLine(line);
      if (ing) ingredients.push(ing);
    }
  }

  // Find steps section
  const steps = [];
  if (stepsStart !== -1) {
    for (let i = stepsStart + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "---" || line.startsWith("# ")) break;
      if (line.startsWith("##")) break;
      if (!line) continue;
      // Strip leading numbers like "1." or "1)"
      const stepText = line.replace(/^\d+[.)]\s*/, "").trim();
      if (stepText) steps.push(stepText);
    }
  }

  if (ingredients.length === 0) {
    console.log(`Warning: "${name}" has no ingredients — skipping`);
    return null;
  }

  return { name, servings, tags, source: "google-doc", ingredients, steps };
}

/**
 * Parses an ingredient line like:
 *   "1.5 lb chicken breast [meat]"
 *   "3 bell peppers [produce]"
 *   "1 pack flour tortillas [bakery] -> 365 flour tortillas"
 *   "2 cups shredded cheese [dairy]"
 */
function parseIngredientLine(line) {
  // Extract optional search_term after ->
  let searchTerm = null;
  const arrowIdx = line.indexOf("->");
  if (arrowIdx !== -1) {
    searchTerm = line.slice(arrowIdx + 2).trim();
    line = line.slice(0, arrowIdx).trim();
  }

  // Extract category from [brackets]
  let category = "other";
  const catMatch = line.match(/\[(\w+)\]\s*$/);
  if (catMatch) {
    const cat = catMatch[1].toLowerCase();
    if (VALID_CATEGORIES.includes(cat)) category = cat;
    line = line.slice(0, catMatch.index).trim();
  }

  // Parse qty and unit from the beginning
  // Matches patterns like: "1.5 lb", "3", "1/2 cup", "one 14-oz can"
  const qtyMatch = line.match(/^([\d./]+)\s*/);
  if (!qtyMatch) {
    // No quantity — treat whole line as name, qty 1
    const result = { name: line.toLowerCase(), qty: 1, unit: "whole", category };
    if (searchTerm) result.search_term = searchTerm;
    return result;
  }

  let qty = qtyMatch[1];
  // Handle fractions like 1/2
  if (qty.includes("/")) {
    const parts = qty.split("/");
    qty = parseFloat(parts[0]) / parseFloat(parts[1]);
  } else {
    qty = parseFloat(qty);
  }

  let rest = line.slice(qtyMatch[0].length).trim();

  // Common units
  const units = [
    "lb", "lbs", "oz", "cup", "cups", "tbsp", "tsp",
    "whole", "bunch", "can", "cans", "jar", "jars",
    "pack", "packs", "bag", "bags", "bottle", "bottles",
    "box", "boxes", "packet", "packets", "clove", "cloves",
    "slice", "slices", "piece", "pieces",
  ];

  let unit = "whole";
  const unitMatch = rest.match(/^(\S+)\s+/);
  if (unitMatch && units.includes(unitMatch[1].toLowerCase())) {
    unit = unitMatch[1].toLowerCase();
    // Normalize plurals
    if (unit.endsWith("s") && units.includes(unit.slice(0, -1))) {
      unit = unit.slice(0, -1);
    }
    rest = rest.slice(unitMatch[0].length).trim();
  }

  const ingredientName = rest.toLowerCase();
  if (!ingredientName) return null;

  const result = { name: ingredientName, qty, unit, category };
  if (searchTerm) result.search_term = searchTerm;
  return result;
}

/**
 * Main sync function: fetches Google Doc, parses recipes, saves to recipes.json.
 * Returns a summary of what changed.
 */
async function syncFromGoogleDoc() {
  const secrets = loadSecrets();
  const docId = secrets.google_doc_id;

  if (!docId) {
    throw new Error(
      'No google_doc_id in config/secrets.json. Add your Google Doc ID (the long string in the doc URL).'
    );
  }

  const text = await fetchGoogleDoc(docId);
  const parsed = parseDocText(text);

  console.log(`Parsed ${parsed.length} recipes from Google Doc`);

  if (parsed.length === 0) {
    return { added: 0, updated: 0, total: loadRecipes().length, message: "No recipes found in doc. Check the format." };
  }

  // Replace all google-doc sourced recipes, keep manually added ones
  const existing = loadRecipes();
  const manualRecipes = existing.filter((r) => r.source !== "google-doc");

  // Merge: doc recipes replace old doc recipes, manual recipes stay
  const merged = [...manualRecipes];
  let added = 0;
  let updated = 0;

  for (const recipe of parsed) {
    const existingIdx = merged.findIndex(
      (r) => r.name.toLowerCase() === recipe.name.toLowerCase()
    );
    if (existingIdx !== -1) {
      merged[existingIdx] = recipe;
      updated++;
    } else {
      merged.push(recipe);
      added++;
    }
  }

  saveRecipes(merged);

  const message = `Synced: ${added} new, ${updated} updated, ${merged.length} total`;
  console.log(message);
  return { added, updated, total: merged.length, message };
}

function loadPantryStaples() {
  if (!fs.existsSync(STAPLES_PATH)) return [];
  return JSON.parse(fs.readFileSync(STAPLES_PATH, "utf-8"));
}

module.exports = { syncFromGoogleDoc, parseDocText, parseIngredientLine, loadRecipes, loadPantryStaples };
