const { CoziApiClient } = require("@brandcast_app/cozi-api-client");
const path = require("path");
const fs = require("fs");

const SECRETS_PATH = path.join(__dirname, "..", "config", "secrets.json");

// Cached client so we don't re-login on every request
let cachedClient = null;

function loadCoziCredentials() {
  const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
  if (!secrets.cozi_email || !secrets.cozi_password) {
    throw new Error("Missing cozi_email or cozi_password in config/secrets.json");
  }
  return { email: secrets.cozi_email, password: secrets.cozi_password };
}

async function getClient() {
  if (cachedClient) return cachedClient;

  const { email, password } = loadCoziCredentials();
  const client = new CoziApiClient();
  await client.authenticate(email, password);
  cachedClient = client;
  console.log("Cozi: authenticated successfully");
  return client;
}

// Clear cached client (e.g. if auth expires)
function resetClient() {
  cachedClient = null;
}

/**
 * Fetch all incomplete items from Cozi shopping lists.
 * Returns [{ text, itemId, listId }]
 */
async function getShoppingList() {
  const client = await getClient();
  const lists = await client.getLists();

  const shoppingLists = lists.filter((l) => l.listType === "shopping" && l.title === "WF");
  const items = [];

  for (const list of shoppingLists) {
    for (const item of list.items) {
      if (item.status === "incomplete") {
        items.push({
          text: item.text,
          itemId: item.itemId,
          listId: list.listId,
        });
      }
    }
  }

  console.log(`Cozi: found ${items.length} shopping items`);
  return items;
}

/**
 * Mark Cozi items as done (after ordering).
 * @param {Array<{itemId, listId}>} items
 */
async function markItemsDone(items) {
  const client = await getClient();
  let marked = 0;

  for (const item of items) {
    try {
      await client.markItem({
        listId: item.listId,
        itemId: item.itemId,
        completed: true,
      });
      marked++;
    } catch (err) {
      console.error(`Cozi: failed to mark item ${item.itemId}: ${err.message}`);
    }
  }

  console.log(`Cozi: marked ${marked}/${items.length} items done`);
  return { marked, total: items.length };
}

module.exports = { getShoppingList, markItemsDone, resetClient };
