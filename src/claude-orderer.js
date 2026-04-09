const { spawn } = require("child_process");
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");

const ORDERS_DIR = path.join(__dirname, "..", "orders");
const CHROME_DATA = path.join(__dirname, "..", "config", "chrome-data");

// Max time an order can run before we kill it (10 minutes)
const ORDER_TIMEOUT_MS = 10 * 60 * 1000;

class ClaudeOrderer extends EventEmitter {
  constructor() {
    super();
    this.state = "idle"; // idle | running | login-needed | cart-ready | checking-out | done | error
    this.results = [];
    this.items = [];
    this.process = null;
    this.timeoutTimer = null;
    this.deliverySlots = [];
    this.cartTotal = null;
  }

  // Override emit to also log to console (matches OrderPlacer behavior)
  emit(event, data) {
    console.log(`[claude-order] ${event}: ${JSON.stringify(data)}`);
    return super.emit(event, data);
  }

  // --- Build the prompt for Claude Code ---

  buildPrompt(items) {
    const itemList = items
      .map((item, i) => {
        const term = item.search_term || item.name;
        return `${i + 1}. "${item.name}" → search for: "${term}"`;
      })
      .join("\n");

    return `You are a grocery ordering assistant. Add items to a Whole Foods cart on Amazon using Puppeteer.

SETUP:
- Write and run a Node.js script using Puppeteer (already installed in this project)
- Use the existing Chrome profile at: ${CHROME_DATA}
- Launch with headless: false, window size 1280x900
- The user is already logged into Amazon in this Chrome profile

ITEMS TO ORDER (${items.length} total):
${itemList}

FOR EACH ITEM:
1. Navigate to https://www.amazon.com/s?k={search_term}&i=wholefoods
2. Wait for search results to load
3. Find the first relevant product result
4. Click "Add to Cart" — try the inline button on search results first, then click into the product page if needed
5. Wait 2-3 seconds between items to avoid rate limiting

CRITICAL OUTPUT FORMAT:
After each item, print EXACTLY one of these status lines to stdout (the brackets and format matter):
  [SEARCHING] item_name
  [ADDED] item_name → product_name
  [SUBSTITUTED] item_name → substitute_product_name
  [NOT_FOUND] item_name → reason
  [ERROR] item_name → error_message

If the product you add is a clearly different item than what was requested (e.g. asked for "barilla rotini" but only found "store brand penne"), use [SUBSTITUTED] instead of [ADDED].

If Amazon asks you to sign in, print this IMMEDIATELY and then exit:
  [LOGIN_NEEDED]

After all items are added, navigate to the cart page (https://www.amazon.com/cart) and print:
  [CART_TOTAL] $XX.XX

Then navigate to the Whole Foods delivery checkout/scheduling page and look for available delivery windows. For each slot you can find, print:
  [SLOT] slot_id | day_and_date | time_range | fee
Example:
  [SLOT] slot-1 | Sunday, Mar 30 | 10am - 12pm | FREE
  [SLOT] slot-2 | Sunday, Mar 30 | 2pm - 4pm | $4.99

When all items are processed and cart/slots are read, print:
  [DONE] X of Y items added

RULES:
- Do NOT proceed to checkout — stop after reading cart total and delivery slots
- If Amazon shows a sign-in page after navigating, print [LOGIN_NEEDED] and stop — do NOT try to log in
- If a search returns no results, try simplifying the search term (drop adjectives like "organic") and retry once
- Prefer Whole Foods / 365 brand products when available
- If "Add to Cart" button is not found with one selector, try others: #add-to-cart-button, #freshAddToCartButton, button[name*="addToCart"], input[name*="addToCart"]
- Keep the browser open when done — the user will review the cart manually
- Write ONE script that handles all items in sequence, don't run separate scripts per item

Write the Puppeteer script to a temp file and execute it with Node.js. Do not use ES modules — use require().`;
  }

  // --- Start the order via Claude Code CLI ---

  async startOrder(items) {
    this.items = items;
    this.results = [];
    this.deliverySlots = [];
    this.cartTotal = null;
    this.state = "running";
    this.clearTimeout();

    this.emit("status", {
      phase: "launching",
      message: "Starting Claude Code session...",
    });

    const prompt = this.buildPrompt(items);

    // Spawn claude CLI in print mode with streaming JSON output
    this.process = spawn("claude", [
      "-p", prompt,
      "--output-format", "stream-json",
      "--allowedTools", "Bash,Read,Write,Edit",
    ], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env },
    });

    // Start timeout timer
    this.timeoutTimer = setTimeout(() => {
      console.log("[claude-order] Order timed out after 10 minutes");
      this.cancel("Order timed out — took longer than 10 minutes. Check Mac terminal.");
    }, ORDER_TIMEOUT_MS);

    let buffer = "";

    this.process.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.trim()) {
          this.handleStreamLine(line.trim());
        }
      }
    });

    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[claude-order stderr] ${text}`);
    });

    this.process.on("close", (code) => {
      this.clearTimeout();
      // Process any remaining buffer
      if (buffer.trim()) {
        this.handleStreamLine(buffer.trim());
      }
      this.finalize(code);
    });

    this.process.on("error", (err) => {
      this.clearTimeout();
      this.state = "error";
      this.emit("status", {
        phase: "error",
        message: `Failed to start Claude Code: ${err.message}`,
      });
    });
  }

  // --- Cancel a running order ---

  cancel(reason) {
    this.clearTimeout();
    if (this.process) {
      this.process.kill("SIGTERM");
      // Force kill after 5 seconds if it doesn't exit
      const forceKill = setTimeout(() => {
        if (this.process) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
      this.process.on("close", () => clearTimeout(forceKill));
    }
    this.state = "error";
    this.emit("status", {
      phase: "error",
      message: reason || "Order cancelled.",
    });
    this.saveOrder();
    this.process = null;
  }

  // --- Cleanup on server shutdown ---

  cleanup() {
    this.clearTimeout();
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  clearTimeout() {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  // --- Parse streaming JSON from Claude Code ---

  handleStreamLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not JSON, skip
    }

    // Extract text content from assistant messages
    if (msg.type === "assistant" && msg.message && msg.message.content) {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          this.parseMarkers(block.text);
        }
      }
    }

    // Also check tool results for our markers (Claude prints them via Bash)
    if (msg.type === "result" && msg.result) {
      this.parseMarkers(msg.result);
    }
  }

  // --- Parse structured markers from Claude's output ---

  parseMarkers(text) {
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      // [LOGIN_NEEDED]
      if (trimmed.match(/^\[LOGIN_NEEDED\]/)) {
        this.clearTimeout();
        this.state = "login-needed";
        this.emit("status", {
          phase: "login-needed",
          message: "Log into Amazon in the browser on your Mac, then tap Continue.",
        });
        continue;
      }

      // [SEARCHING] item_name
      const searchMatch = trimmed.match(/^\[SEARCHING\]\s*(.+)$/);
      if (searchMatch) {
        const name = searchMatch[1].trim();
        const index = this.findItemIndex(name);
        this.emit("status", {
          phase: "ordering",
          message: `Searching for ${name}...`,
        });
        if (index >= 0) {
          this.emit("item", {
            index,
            total: this.items.length,
            name,
            status: "searching",
          });
        }
        continue;
      }

      // [ADDED] item_name → product_name
      const addedMatch = trimmed.match(/^\[ADDED\]\s*(.+?)\s*→\s*(.+)$/);
      if (addedMatch) {
        const name = addedMatch[1].trim();
        const product = addedMatch[2].trim();
        const index = this.findItemIndex(name);
        // Guard against duplicate results on retry
        if (!this.hasResult(name)) {
          this.results.push({ name, found: true, productName: product });
        }
        if (index >= 0) {
          this.emit("item", {
            index,
            total: this.items.length,
            name,
            status: "added",
            product,
          });
        }
        continue;
      }

      // [NOT_FOUND] item_name → reason
      const notFoundMatch = trimmed.match(/^\[NOT_FOUND\]\s*(.+?)\s*→\s*(.+)$/);
      if (notFoundMatch) {
        const name = notFoundMatch[1].trim();
        const reason = notFoundMatch[2].trim();
        const index = this.findItemIndex(name);
        if (!this.hasResult(name)) {
          this.results.push({ name, found: false, reason });
        }
        if (index >= 0) {
          this.emit("item", {
            index,
            total: this.items.length,
            name,
            status: "not_found",
            reason,
          });
        }
        continue;
      }

      // [ERROR] item_name → error_message
      const errorMatch = trimmed.match(/^\[ERROR\]\s*(.+?)\s*→\s*(.+)$/);
      if (errorMatch) {
        const name = errorMatch[1].trim();
        const reason = errorMatch[2].trim();
        const index = this.findItemIndex(name);
        if (!this.hasResult(name)) {
          this.results.push({ name, found: false, reason, error: true });
        }
        if (index >= 0) {
          this.emit("item", {
            index,
            total: this.items.length,
            name,
            status: "error",
            reason,
          });
        }
        continue;
      }

      // [SUBSTITUTED] item_name → substitute_product_name
      const subMatch = trimmed.match(/^\[SUBSTITUTED\]\s*(.+?)\s*→\s*(.+)$/);
      if (subMatch) {
        const name = subMatch[1].trim();
        const product = subMatch[2].trim();
        const index = this.findItemIndex(name);
        if (!this.hasResult(name)) {
          this.results.push({ name, found: true, productName: product, substituted: true });
        }
        if (index >= 0) {
          this.emit("item", {
            index,
            total: this.items.length,
            name,
            status: "substituted",
            product,
          });
        }
        continue;
      }

      // [CART_TOTAL] $XX.XX
      const cartMatch = trimmed.match(/^\[CART_TOTAL\]\s*\$?([\d.]+)/);
      if (cartMatch) {
        this.cartTotal = parseFloat(cartMatch[1]);
        this.emit("status", {
          phase: "cart-review",
          message: `Cart total: $${this.cartTotal.toFixed(2)}`,
          cartTotal: this.cartTotal,
        });
        continue;
      }

      // [SLOT] slot_id | day_and_date | time_range | fee
      const slotMatch = trimmed.match(/^\[SLOT\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/);
      if (slotMatch) {
        this.deliverySlots.push({
          id: slotMatch[1].trim(),
          date: slotMatch[2].trim(),
          time: slotMatch[3].trim(),
          fee: slotMatch[4].trim(),
        });
        this.emit("status", {
          phase: "reading-slots",
          message: `Found delivery slot: ${slotMatch[2].trim()} ${slotMatch[3].trim()}`,
        });
        continue;
      }

      // [CHECKOUT_READY] order_total
      const checkoutMatch = trimmed.match(/^\[CHECKOUT_READY\]\s*(.*)$/);
      if (checkoutMatch) {
        this.emit("status", {
          phase: "checkout-ready",
          message: "Checkout is ready — go to your Mac and click 'Place your order'.",
          orderTotal: checkoutMatch[1].trim(),
        });
        continue;
      }

      // [CHECKOUT_ERROR] description
      const checkoutErrMatch = trimmed.match(/^\[CHECKOUT_ERROR\]\s*(.+)$/);
      if (checkoutErrMatch) {
        this.emit("status", {
          phase: "error",
          message: `Checkout error: ${checkoutErrMatch[1].trim()}`,
        });
        continue;
      }

      // [DONE] X of Y items added
      const doneMatch = trimmed.match(/^\[DONE\]\s*(\d+)\s*of\s*(\d+)/);
      if (doneMatch) {
        // Done marker handled in finalize()
        continue;
      }
    }
  }

  // Check if we already have a result for this item (prevents duplicates on retry)
  hasResult(name) {
    const lower = name.toLowerCase();
    return this.results.some((r) => r.name.toLowerCase() === lower);
  }

  // --- Find item index by name (fuzzy) ---

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

  // --- Finalize when Claude Code exits ---

  finalize(exitCode) {
    if (this.state === "error") return; // already handled

    const added = this.results.filter((r) => r.found).length;
    const notFound = this.results.filter((r) => !r.found);

    // Fill in any items that weren't reported
    for (const item of this.items) {
      const hasResult = this.results.some(
        (r) => r.name.toLowerCase() === item.name.toLowerCase()
      );
      if (!hasResult) {
        this.results.push({
          name: item.name,
          found: false,
          reason: "No result reported by Claude",
        });
      }
    }

    if (exitCode !== 0 && added === 0) {
      this.state = "error";
      this.emit("status", {
        phase: "error",
        message: `Claude Code exited with code ${exitCode}. Check Mac terminal for details.`,
      });
    } else {
      // If we got cart info, go to cart-ready state for review
      // Otherwise go straight to done (fallback)
      this.state = this.cartTotal !== null || this.deliverySlots.length > 0
        ? "cart-ready"
        : "done";

      const phase = this.state === "cart-ready" ? "cart-ready" : "complete";

      this.emit("status", {
        phase,
        message: this.state === "cart-ready"
          ? `${added} items in cart — review and pick a delivery slot.`
          : `Done! ${added} of ${this.items.length} items added to cart.`,
        added,
        total: this.items.length,
        cartTotal: this.cartTotal,
        deliverySlots: this.deliverySlots,
        substitutions: this.results.filter((r) => r.substituted).map((r) => ({
          name: r.name,
          product: r.productName,
        })),
        notFound: notFound.map((r) => ({
          name: r.name,
          reason: r.reason || "unknown",
        })),
        results: this.results,
      });
    }

    this.saveOrder();
    this.process = null;
  }

  // --- Continue after login — restart Claude session with remaining items ---

  async continueAfterLogin() {
    if (this.state !== "login-needed") return;

    // Figure out which items haven't been processed yet
    const remaining = this.items.filter(
      (item) => !this.hasResult(item.name)
    );

    if (remaining.length === 0) {
      this.state = "done";
      this.emit("status", {
        phase: "complete",
        message: "All items were already processed.",
        added: this.results.filter((r) => r.found).length,
        total: this.items.length,
        notFound: this.results.filter((r) => !r.found).map((r) => ({
          name: r.name,
          reason: r.reason || "unknown",
        })),
      });
      return;
    }

    // Restart with remaining items (user has now logged in on Mac)
    this.state = "running";
    this.emit("status", {
      phase: "ordering",
      message: `Resuming — ${remaining.length} items left...`,
    });

    const prompt = this.buildPrompt(remaining);

    this.process = spawn("claude", [
      "-p", prompt,
      "--output-format", "stream-json",
      "--allowedTools", "Bash,Read,Write,Edit",
    ], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env },
    });

    this.timeoutTimer = setTimeout(() => {
      this.cancel("Order timed out after 10 minutes.");
    }, ORDER_TIMEOUT_MS);

    let buffer = "";

    this.process.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.handleStreamLine(line.trim());
      }
    });

    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[claude-order stderr] ${text}`);
    });

    this.process.on("close", (code) => {
      this.clearTimeout();
      if (buffer.trim()) this.handleStreamLine(buffer.trim());
      this.finalize(code);
    });

    this.process.on("error", (err) => {
      this.clearTimeout();
      this.state = "error";
      this.emit("status", {
        phase: "error",
        message: `Failed to restart Claude Code: ${err.message}`,
      });
    });
  }

  // --- Checkout phase ---

  buildCheckoutPrompt(slotId) {
    return `You are completing a Whole Foods checkout on Amazon.

SETUP:
- Write and run a Node.js script using Puppeteer (already installed in this project)
- Use the existing Chrome profile at: ${CHROME_DATA}
- Launch with headless: false, window size 1280x900
- The user is already logged into Amazon and has items in their Whole Foods cart

TASK:
1. Navigate to the Whole Foods checkout page
2. ${slotId ? `Select the delivery slot with id or matching "${slotId}"` : "Select the first available FREE delivery slot, or the cheapest one"}
3. Proceed through checkout until you reach the final "Place your order" button
4. STOP — do NOT click "Place your order"
5. Take a screenshot if possible so the user can verify

Print these markers:
  [CHECKOUT_READY] order_total
when you've reached the final confirmation page.

If anything goes wrong:
  [CHECKOUT_ERROR] description

If Amazon asks to sign in:
  [LOGIN_NEEDED]

CRITICAL: Do NOT place the order. Stop at the review/confirmation page.
Write one Puppeteer script, use require() not ES modules.`;
  }

  async startCheckout(slotId) {
    if (this.state !== "cart-ready") return;

    this.state = "checking-out";
    this.emit("status", {
      phase: "checking-out",
      message: "Starting checkout...",
    });

    const prompt = this.buildCheckoutPrompt(slotId);

    this.process = spawn("claude", [
      "-p", prompt,
      "--output-format", "stream-json",
      "--allowedTools", "Bash,Read,Write,Edit",
    ], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env },
    });

    this.timeoutTimer = setTimeout(() => {
      this.cancel("Checkout timed out after 10 minutes.");
    }, ORDER_TIMEOUT_MS);

    let buffer = "";

    this.process.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.handleStreamLine(line.trim());
      }
    });

    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[claude-checkout stderr] ${text}`);
    });

    this.process.on("close", (code) => {
      this.clearTimeout();
      if (buffer.trim()) this.handleStreamLine(buffer.trim());
      this.finalizeCheckout(code);
    });

    this.process.on("error", (err) => {
      this.clearTimeout();
      this.state = "error";
      this.emit("status", {
        phase: "error",
        message: `Checkout failed to start: ${err.message}`,
      });
    });
  }

  finalizeCheckout(exitCode) {
    if (this.state === "error") return;

    this.state = "done";
    this.emit("status", {
      phase: "checkout-ready",
      message: "Checkout is ready — go to your Mac and click 'Place your order' to confirm.",
    });
    this.saveOrder();
    this.process = null;
  }

  // --- Save order history ---

  saveOrder() {
    if (!fs.existsSync(ORDERS_DIR)) {
      fs.mkdirSync(ORDERS_DIR, { recursive: true });
    }

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16).replace(":", "");
    const file = path.join(ORDERS_DIR, `order-${date}-${time}.json`);

    const data = {
      date: now.toISOString(),
      engine: "claude-code",
      itemsRequested: this.items.length,
      itemsAdded: this.results.filter((r) => r.found).length,
      results: this.results,
    };

    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log(`[claude-order] Saved to ${file}`);
  }
}

// Singleton — only one order at a time
let instance = null;

function getClaudeOrderer() {
  if (!instance) instance = new ClaudeOrderer();
  return instance;
}

module.exports = { getClaudeOrderer };
