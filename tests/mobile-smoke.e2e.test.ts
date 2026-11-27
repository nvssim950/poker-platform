/**
 * End-to-End Mobile Browser Smoke Verification
 *
 * Drives three mobile-viewport Chromium contexts (Host + Player 2 + Player 3)
 * against the real HTTP + WebSocket gateway and SQLite store through a complete
 * simplified casual Texas Hold'em Session lifecycle.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const CHROMIUM_PATH = "/usr/bin/chromium";
const PROJECT_ROOT = resolve(import.meta.dirname ?? ".", "..");
const STATIC_DIR = resolve(PROJECT_ROOT, "dist/client");

async function waitVisible(locator: Locator, timeoutMs = 8000): Promise<void> {
  await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
}

async function waitForCondition(
  page: Page,
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    dims.scrollWidth <= dims.innerWidth + 1,
    `${label} overflows horizontally on mobile (${dims.scrollWidth}px > ${dims.innerWidth}px)`,
  );
}

describe("E2E Mobile Smoke", { timeout: 120_000 }, () => {
  let tmpDir: string;
  let pwTmpDir: string;
  let gateway: SessionGateway;
  let baseUrl: string;
  let browser: Browser;

  before(async () => {
    execSync("./node_modules/.bin/vite build", { cwd: PROJECT_ROOT, stdio: "pipe" });

    tmpDir = mkdtempSync(join(tmpdir(), "poker-e2e-"));
    pwTmpDir = mkdtempSync(join(tmpdir(), "pw-home-"));
    const dbPath = join(tmpDir, "e2e.db");

    gateway = createSessionGateway({ dbPath, staticDir: STATIC_DIR });
    baseUrl = await gateway.listen(0, "127.0.0.1");

    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: {
        ...process.env,
        HOME: pwTmpDir,
        XDG_CONFIG_HOME: join(pwTmpDir, ".config"),
        XDG_CACHE_HOME: join(pwTmpDir, ".cache"),
      },
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (gateway) await gateway.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (pwTmpDir) rmSync(pwTmpDir, { recursive: true, force: true });
  });

  it("verifies simplified mobile Session flow from presets through quick bets, Undo, Showdown, Rebuy, Leave, and End Game Leaderboard", async () => {
    assert.ok(existsSync(join(STATIC_DIR, "index.html")));
    const hostCtx: BrowserContext = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const p2Ctx: BrowserContext = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const p3Ctx: BrowserContext = await browser.newContext({ viewport: MOBILE_VIEWPORT });

    const hostPage = await hostCtx.newPage();
    const p2Page = await p2Ctx.newPage();
    const p3Page = await p3Ctx.newPage();

    try {
      /* 1. Host creates Session using simple preset (Short: 500 Chips · 5/10) */
      await hostPage.goto(baseUrl);
      await waitVisible(hostPage.getByRole("heading", { name: "Create New Session (Host)" }));

      await hostPage.locator("#seat-count").selectOption("4");
      await hostPage.getByRole("button", { name: "Short (500 · 5/10)" }).click();
      await hostPage.getByRole("button", { name: "Open Session" }).click();

      await waitVisible(hostPage.getByText("Live Sync"));
      await waitVisible(hostPage.getByText("Stack 500 Chips"));
      await waitVisible(hostPage.getByText("Blinds 5/10"));
      await waitVisible(hostPage.locator("img[alt^='QR code for Session']"));
      const shareUrl = (await hostPage.locator(".mono-link").first().textContent())?.trim() ?? "";
      assert.ok(shareUrl.includes("/s/"), `Expected invite link with /s/, got: ${shareUrl}`);

      /* 2. Host claims Seat 1 (Alice); Players 2 (Bob) & 3 (Charlie) join -> auto-funded 500 Chips */
      await hostPage.getByRole("button", { name: "Claim" }).nth(0).click();
      await hostPage.locator("#player-name").fill("Alice");
      await hostPage.getByRole("button", { name: "Take Seat 1" }).click();
      await waitVisible(hostPage.locator(".seat-card.seat-mine", { hasText: "Alice" }).getByText("500 Chips"));

      await p2Page.goto(shareUrl);
      await waitVisible(p2Page.getByText("Live Sync"));
      await p2Page.getByRole("button", { name: "Claim" }).first().click();
      await p2Page.locator("#player-name").fill("Bob");
      await p2Page.getByRole("button", { name: "Take Seat 2" }).click();
      await waitVisible(p2Page.locator(".seat-card.seat-mine", { hasText: "500 Chips" }));

      await p3Page.goto(shareUrl);
      await waitVisible(p3Page.getByText("Live Sync"));
      await p3Page.getByRole("button", { name: "Claim" }).first().click();
      await p3Page.locator("#player-name").fill("Charlie");
      await p3Page.getByRole("button", { name: "Take Seat 3" }).click();
      await waitVisible(p3Page.locator(".seat-card.seat-mine", { hasText: "500 Chips" }));

      /* 3. Browser reload restores Seat 3 via localStorage reconnect token */
      await p3Page.reload();
      await waitVisible(p3Page.getByText("Live Sync"));
      const p3SeatCard = p3Page.locator(".seat-card.seat-mine", { hasText: "Charlie" });
      await waitVisible(p3SeatCard.getByText("You", { exact: true }));
      await assertNoHorizontalOverflow(hostPage, "Host Lobby");

      /* 4. Host starts Hand #1 -> verify unified Seat list & quick bet buttons */
      await hostPage.getByRole("button", { name: "Start Hand #1" }).click();
      await waitVisible(hostPage.getByText("Hand #1 · Preflop"));
      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));

      // Verify single unified Seats card (4 seats total, not duplicated)
      const seatsCard = hostPage.locator(".card", {
        has: hostPage.getByRole("heading", { name: "Seats (4)" }),
      });
      assert.equal(await seatsCard.locator(".seat-card").count(), 4);

      // Quick bet presets present: tap "Pot" (raises to 35), then Raise to 35
      const actionBar = hostPage.locator(".action-bar");
      for (const preset of ["Min", "½ Pot", "Pot", "All-In"]) {
        await waitVisible(actionBar.getByRole("button", { name: preset, exact: true }));
      }
      await actionBar.getByRole("button", { name: "Pot", exact: true }).click();
      await actionBar.getByRole("button", { name: "Raise to 35" }).click();

      // Host Proxy Call for Seat 2 (Bob)
      await waitVisible(hostPage.getByText("Host Proxy Action · Seat 2 (Bob)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "Call 30" }).click();

      // Seat 3 calls 25 -> Flop (Pot 105)
      await waitVisible(p3Page.getByText("Your Action (Seat 3)"));
      await p3Page.locator(".action-bar").getByRole("button", { name: "Call 25" }).click();
      await waitVisible(hostPage.getByText("Hand #1 · Flop"));

      /* 5. Check Flop -> Turn, test Host Undo, then Alice & Bob go All-In and Charlie folds */
      await waitVisible(hostPage.getByText("Host Proxy Action · Seat 2 (Bob)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "Check" }).click();
      await waitVisible(p3Page.getByText("Your Action (Seat 3)"));
      await p3Page.locator(".action-bar").getByRole("button", { name: "Check" }).click();
      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "Check" }).click();
      await waitVisible(hostPage.getByText("Hand #1 · Turn"));

      const undoBtn = hostPage.getByRole("button", { name: "Undo", exact: true });
      await undoBtn.click();
      await waitVisible(hostPage.getByText("Hand #1 · Flop"));
      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "All-In (465)" }).click();

      await waitVisible(hostPage.getByText("Host Proxy Action · Seat 2 (Bob)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "All-In (465)" }).click();

      await waitVisible(p3Page.getByText("Your Action (Seat 3)"));
      await p3Page.locator(".action-bar").getByRole("button", { name: "Fold" }).click();

      await waitVisible(hostPage.getByText("Hand #1 · Showdown"));

      /* 6. Host awards Main Pot (1035) to Alice (Seat 1) -> Bob busts to 0 Chips */
      const mainPotBox = hostPage.locator(".action-bar", { hasText: "Main Pot · 1035 Chips" });
      await waitVisible(mainPotBox);
      await mainPotBox.locator("button.showdown-option", { hasText: "Seat 1 · Alice" }).click();
      await mainPotBox.getByRole("button", { name: "Award Main Pot (1035 Chips)" }).click();

      await waitVisible(hostPage.getByText("Hand #1 Complete"));

      /* 7. Bob performs one-tap Rebuy at 0 Chips; Charlie leaves Seat 3 */
      const p2Mine = p2Page.locator(".seat-card.seat-mine", { hasText: "Bob" });
      await waitVisible(p2Mine.getByText("0 Chips"));
      await p2Mine.getByRole("button", { name: "Rebuy" }).click();
      await waitVisible(p2Mine.getByText("500 Chips"));

      await p3Page.locator(".seat-card.seat-mine").getByRole("button", { name: "Leave" }).click();
      await waitForCondition(
        p3Page,
        async () => (await p3Page.locator(".seat-card.seat-mine").count()) === 0,
        "Seat 3 opens after Charlie leaves",
      );

      /* 8. Host ends game -> verifies Final Chip Leaderboard across phones */
      await hostPage.getByRole("button", { name: "End Game" }).click();
      await hostPage.getByRole("button", { name: "Confirm End Game" }).click();

      await waitVisible(hostPage.getByRole("heading", { name: "Final Chip Leaderboard" }));
      await waitVisible(hostPage.getByText("+535 Chips"));
      await waitVisible(hostPage.getByText("-35 Chips"));
      await waitVisible(hostPage.getByText("-500 Chips"));
      await waitVisible(p2Page.getByRole("heading", { name: "Final Chip Leaderboard" }));

      await assertNoHorizontalOverflow(hostPage, "Host Leaderboard");
      await assertNoHorizontalOverflow(p2Page, "Player 2 Leaderboard");
    } finally {
      await hostCtx.close();
      await p2Ctx.close();
      await p3Ctx.close();
    }
  });
});
