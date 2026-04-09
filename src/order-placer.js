const puppeteer = require("puppeteer");
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");

const CHROME_DATA = path.join(__dirname, "..", "config", "chrome-data");
const ORDERS_DIR = path.join(__dirname, "..", "orders");

// How long to wait between adding items (ms) — be gentle on Amazon
const ITEM_DELAY = 2500;

class OrderPlacer extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.page = null;
    this.state = "idle"; // idle | running | login-needed | done | error
    this.results = [];
    this.items = [];
  }

  // Override emit to also log to console
  emit(event, data) {
    console.log(`[order] ${event}: ${JSON.stringify(data)}`);
    return super.emit(event, data);
  }

  // --- Browser lifecycle ---

  async launch() {
    this.browser = await puppeteer.launch({
      headless: false, // Must be visible — user watches it work
      userDataDir: CHROME_DATA,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=1280,900",
      ],
      defaultViewport: { width: 1280, height: 900 },
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());

    await this.page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    this.browser.on("disconnected", () => {
      this.browser = null;
      this.page = null;
      if (this.state === "running") {
        this.state = "error";
        this.emit("status", {
          phase: "error",
          message: "Browser was closed. Tap Back and try again.",
        });
      }
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
    this.state = "idle";
  }

  // --- Amazon login check ---

  async checkLogin() {
    await this.page.goto("https://www.amazon.com/gp/css/homepage.html", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });
    const url = this.page.url();
    return !url.includes("signin") && !url.includes("ap/signin");
  }

  // --- Search and add a single item ---

  async searchAndAdd(searchTerm) {
    const encoded = encodeURIComponent(searchTerm);
    const url = `https://www.amazon.com/s?k=${encoded}&i=wholefoods`;

    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Wait for search results
    try {
      await this.page.waitForSelector(
        '[data-component-type="s-search-result"]',
        { timeout: 8000 }
      );
    } catch {
      return { found: false, reason: "No results found" };
    }

    // Grab first result
    const firstResult = await this.page.$(
      '[data-component-type="s-search-result"]'
    );
    if (!firstResult) {
      return { found: false, reason: "No results found" };
    }

    // Get product name from the result
    const productName = await firstResult
      .$eval("h2", (el) => el.textContent.trim())
      .catch(() => searchTerm);

    // Try inline "Add to Cart" button on search results page first
    const inlineAdded = await this.tryInlineAddToCart(firstResult);
    if (inlineAdded) {
      return { found: true, productName };
    }

    // Fallback: click into product page and add from there
    const link = await firstResult.$('h2 a, a.a-link-normal[href*="/dp/"]');
    if (!link) {
      return { found: false, reason: "Could not open product page", productName };
    }

    await Promise.all([
      this.page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {}),
      link.click(),
    ]);

    const pageAdded = await this.tryProductPageAddToCart();
    if (pageAdded) {
      return { found: true, productName };
    }

    return { found: false, reason: "No Add to Cart button found", productName };
  }

  // Try clicking an add-to-cart button on the search results page
  async tryInlineAddToCart(resultEl) {
    const selectors = [
      'button[name*="addToCart"]',
      'input[name*="addToCart"]',
      '[data-action="afw-add-to-cart"] button',
      ".a-button-input",
    ];

    for (const sel of selectors) {
      const btn = await resultEl.$(sel);
      if (btn) {
        await btn.click();
        await this.wait(2000);
        return true;
      }
    }
    return false;
  }

  // Try clicking Add to Cart on a product detail page
  async tryProductPageAddToCart() {
    const selectors = [
      "#add-to-cart-button",
      "#add-to-cart-button-ubb",
      "#freshAddToCartButton",
      'input[name="submit.add-to-cart"]',
      'input[name="submit.addToCart"]',
      "#add-to-fresh-cart",
    ];

    for (const sel of selectors) {
      const btn = await this.page.$(sel);
      if (btn) {
        await btn.click();
        await this.wait(2500);
        return true;
      }
    }
    return false;
  }

  // --- Main order flow ---

  async startOrder(items) {
    this.items = items;
    this.results = [];
    this.state = "running";

    try {
      this.emit("status", {
        phase: "launching",
        message: "Opening browser...",
      });
      await this.launch();

      this.emit("status", {
        phase: "login-check",
        message: "Checking Amazon login...",
      });
      const loggedIn = await this.checkLogin();

      if (!loggedIn) {
        this.state = "login-needed";
        this.emit("status", {
          phase: "login-needed",
          message:
            "Log into Amazon in the browser on your Mac, then tap Continue.",
        });
        return;
      }

      await this.processItems();
    } catch (err) {
      this.state = "error";
      this.emit("status", {
        phase: "error",
        message: `Failed to start: ${err.message}`,
      });
    }
  }

  async continueAfterLogin() {
    try {
      this.emit("status", {
        phase: "login-check",
        message: "Checking login...",
      });

      const loggedIn = await this.checkLogin();
      if (!loggedIn) {
        this.emit("status", {
          phase: "login-needed",
          message: "Still not logged in. Please sign into Amazon first.",
        });
        return;
      }

      this.state = "running";
      await this.processItems();
    } catch (err) {
      this.state = "error";
      this.emit("status", {
        phase: "error",
        message: err.message,
      });
    }
  }

  async processItems() {
    const items = this.items;
    this.emit("status", {
      phase: "ordering",
      message: `Adding ${items.length} items to your Whole Foods cart...`,
    });

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const searchTerm = item.search_term || item.name;

      this.emit("item", {
        index: i,
        total: items.length,
        name: item.name,
        status: "searching",
      });

      try {
        const result = await this.searchAndAdd(searchTerm);
        this.results.push({ name: item.name, searchTerm, ...result });

        this.emit("item", {
          index: i,
          total: items.length,
          name: item.name,
          status: result.found ? "added" : "not_found",
          product: result.productName || null,
          reason: result.reason || null,
        });
      } catch (err) {
        this.results.push({
          name: item.name,
          searchTerm,
          found: false,
          error: err.message,
        });
        this.emit("item", {
          index: i,
          total: items.length,
          name: item.name,
          status: "error",
          reason: err.message,
        });
      }

      // Pause between items
      if (i < items.length - 1) {
        await this.wait(ITEM_DELAY);
      }
    }

    // Summary
    const added = this.results.filter((r) => r.found).length;
    const notFound = this.results.filter((r) => !r.found);

    this.state = "done";
    this.emit("status", {
      phase: "complete",
      message: `Done! ${added} of ${items.length} items added to cart.`,
      added,
      total: items.length,
      notFound: notFound.map((r) => ({
        name: r.name,
        reason: r.reason || r.error || "unknown",
      })),
    });

    this.saveOrder();
  }

  // --- Order history ---

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
      itemsRequested: this.items.length,
      itemsAdded: this.results.filter((r) => r.found).length,
      results: this.results,
    };

    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    console.log(`[order] Saved to ${file}`);
  }

  // --- Helpers ---

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton — only one order at a time
let instance = null;

function getOrderPlacer() {
  if (!instance) instance = new OrderPlacer();
  return instance;
}

module.exports = { getOrderPlacer };
