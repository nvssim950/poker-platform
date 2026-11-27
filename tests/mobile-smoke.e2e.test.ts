/**
 * End-to-End Mobile Browser Smoke Verification
 *
 * Drives three mobile-viewport Chromium contexts (Host + Player 2 + Player 3)
 * against the real HTTP + WebSocket gateway and SQLite store through a complete
 * Session lifecycle:
 *   1. Host creates Session -> QR code and invite link render
 *   2. Host claims Seat 1; Players 2 & 3 join via share URL & claim Seats 2 & 3
 *   3. Player 3 reloads browser -> reconnect token restores Seat 3 ("You" badge)
 *   4. Players 2 & 3 submit Buy-In requests in UI; Host approves in UI; Host records Seat 1 Buy-In
 *   5. Host starts Hand #1 -> verifies minimal slider/numeric Action bar (no quick-bet presets)
 *   6. Seat 1 raises to 150 via numeric input; Host submits Proxy All-In for Seat 2 (100 short stack);
 *      Seat 3 calls 150 in UI -> produces Main Pot (300) + Side Pot 1 (100) on Flop
 *   7. Multi-step Host Undo across Street transition (Turn -> Flop -> prior action), then check down to Showdown
 *   8. Host resolves Main Pot (300) & Side Pot 1 (100) in Showdown UI -> Hand #1 Complete
 *   9. Between Hands: Player 3 requests Early Cash-Out -> Host approves -> Seat 3 opens
 *  10. Host settles Session in UI -> verifies Zero-Sum Balanced Settlement & Cash Transfers on mobile
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

/**
 * Waits for a Locator to become visible within timeout.
 */
async function waitVisible(locator: Locator, timeoutMs = 8000): Promise<void> {
  await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
}

/**
 * Polls an async predicate until true or throws a descriptive timeout error.
 */
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

/**
 * Asserts the page fits inside the 390px mobile viewport without horizontal overflow.
 */
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
    if (!existsSync(join(STATIC_DIR, "index.html"))) {
      execSync("./node_modules/.bin/vite build", { cwd: PROJECT_ROOT, stdio: "pipe" });
    }

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

  it("verifies full mobile Session flow from creation through Side Pot, Undo, Cash-Out, and Settlement", async () => {
    const hostCtx: BrowserContext = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const p2Ctx: BrowserContext = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const p3Ctx: BrowserContext = await browser.newContext({ viewport: MOBILE_VIEWPORT });

    const hostPage = await hostCtx.newPage();
    const p2Page = await p2Ctx.newPage();
    const p3Page = await p3Ctx.newPage();

    try {
      /* 1. Host creates Session (4 Seats, 10/20 blinds, step 5, 100 Chips = $1.00, 100-2000 Buy-In) */
      await hostPage.goto(baseUrl);
      await waitVisible(hostPage.getByRole("heading", { name: "Create New Session (Host)" }));

      await hostPage.locator("#seat-count").selectOption("4");
      await hostPage.locator("#sb").fill("10");
      await hostPage.locator("#bb").fill("20");
      await hostPage.locator("#chip-step").fill("5");
      await hostPage.locator("#rate-chips").fill("100");
      await hostPage.locator("#rate-cash").fill("1.00");
      await hostPage.locator("#min-buyin").fill("100");
      await hostPage.locator("#max-buyin").fill("2000");

      await hostPage.getByRole("button", { name: "Open Session" }).click();

      await waitVisible(hostPage.getByText("Live Sync"));
      await waitVisible(hostPage.locator("img[alt^='QR code for Session']"));
      const shareUrl = (await hostPage.locator(".mono-link").first().textContent())?.trim() ?? "";
      assert.ok(shareUrl.includes("/s/"), `Expected invite link with /s/, got: ${shareUrl}`);

      /* 2. Host claims Seat 1 (Alice); Players 2 (Bob) & 3 (Charlie) join via invite link */
      await hostPage.getByRole("button", { name: "Claim" }).nth(0).click();
      await hostPage.locator("#player-name").fill("Alice");
      await hostPage.getByRole("button", { name: "Take Seat 1" }).click();
      await waitVisible(hostPage.locator(".seat-card.seat-mine", { hasText: "Alice" }));

      await p2Page.goto(shareUrl);
      await waitVisible(p2Page.getByText("Live Sync"));
      await p2Page.getByRole("button", { name: "Claim" }).first().click();
      await p2Page.locator("#player-name").fill("Bob");
      await p2Page.getByRole("button", { name: "Take Seat 2" }).click();
      await waitVisible(p2Page.locator(".seat-card.seat-mine", { hasText: "Bob" }));

      await p3Page.goto(shareUrl);
      await waitVisible(p3Page.getByText("Live Sync"));
      await p3Page.getByRole("button", { name: "Claim" }).first().click();
      await p3Page.locator("#player-name").fill("Charlie");
      await p3Page.getByRole("button", { name: "Take Seat 3" }).click();
      await waitVisible(p3Page.locator(".seat-card.seat-mine", { hasText: "Charlie" }));

      /* 3. Browser reload restores Seat 3 via localStorage reconnect token */
      await p3Page.reload();
      await waitVisible(p3Page.getByText("Live Sync"));
      const p3SeatCard = p3Page.locator(".seat-card.seat-mine", { hasText: "Charlie" });
      await waitVisible(p3SeatCard);
      await waitVisible(p3SeatCard.getByText("You", { exact: true }));

      /* 4. Buy-In workflow in UI: Alice (Host direct 400), Bob requests 100, Charlie requests 400 -> Host approves */
      await hostPage.locator("#host-seat-select").selectOption("1");
      await hostPage.locator("#host-funding-amount").fill("400");
      await hostPage.getByRole("button", { name: "Record Buy-In for Seat 1" }).click();
      await waitVisible(hostPage.locator(".seat-card", { hasText: "Alice" }).getByText("400 Chips"));

      await p2Page.locator("#player-funding-amount").fill("100");
      await p2Page.getByRole("button", { name: "Request Buy-In" }).click();
      await waitVisible(p2Page.getByText("Pending Buy-In"));

      await p3Page.locator("#player-funding-amount").fill("400");
      await p3Page.getByRole("button", { name: "Request Buy-In" }).click();
      await waitVisible(p3Page.getByText("Pending Buy-In"));

      // Host approves both pending Buy-In requests
      await waitVisible(hostPage.getByRole("heading", { name: "Pending Requests" }));
      for (let i = 0; i < 2; i += 1) {
        await hostPage.getByRole("button", { name: "Approve" }).first().click();
        await hostPage.waitForTimeout(150);
      }

      await waitVisible(p2Page.locator(".seat-card.seat-mine", { hasText: "100 Chips" }));
      await waitVisible(p3Page.locator(".seat-card.seat-mine", { hasText: "400 Chips" }));
      await assertNoHorizontalOverflow(hostPage, "Host Lobby");

      /* 5. Host starts Hand #1 -> Seat 1 (Alice) is BTN and first to act Preflop */
      await hostPage.getByRole("button", { name: "Start Hand #1" }).click();
      await waitVisible(hostPage.getByText("Hand #1 · Preflop"));
      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));

      // Verify minimal Action bar: slider & numeric input present, ZERO quick-bet preset buttons
      const actionBar = hostPage.locator(".action-bar");
      await waitVisible(actionBar.locator("#hand-wager-slider"));
      await waitVisible(actionBar.locator("#hand-wager-input"));
      for (const forbidden of ["1/2 Pot", "2/3 Pot", "Pot", "3x", "Min"]) {
        assert.equal(
          await actionBar.getByRole("button", { name: forbidden, exact: true }).count(),
          0,
          `Unexpected quick-bet preset button "${forbidden}" in Action bar`,
        );
      }

      // Seat 1 (Alice) raises to 150 via numeric input
      await actionBar.locator("#hand-wager-input").fill("150");
      await actionBar.getByRole("button", { name: "Raise to 150" }).click();

      /* 6. Host Proxy Action for Seat 2 (Bob, 90 Chips left behind SB 10 -> Call 100 All-In) */
      await waitVisible(hostPage.getByText("Host Proxy Action · Seat 2 (Bob)"));
      const proxyCallBtn = hostPage
        .locator(".action-bar button")
        .filter({ hasText: /All-In/ })
        .first();
      await proxyCallBtn.click();

      /* 7. Seat 3 (Charlie) calls 130 on his mobile browser -> Flop with Main Pot (300) + Side Pot 1 (100) */
      await waitVisible(p3Page.getByText("Your Action (Seat 3)"));
      await p3Page.locator(".action-bar").getByRole("button", { name: "Call 130" }).click();

      await waitVisible(hostPage.getByText("Hand #1 · Flop"));
      await waitVisible(hostPage.locator(".pot-card", { hasText: "Main Pot" }).getByText("300 Chips"));
      await waitVisible(hostPage.locator(".pot-card", { hasText: "Side Pot 1" }).getByText("100 Chips"));
      await waitVisible(p2Page.locator(".pot-card", { hasText: "Main Pot" }).getByText("300 Chips"));
      await assertNoHorizontalOverflow(hostPage, "Host Flop Side Pots");

      /* 8. Check Flop -> advances to Turn, then test Multi-Step Host Undo across Street transition */
      await waitVisible(p3Page.getByText("Your Action (Seat 3)"));
      await p3Page.locator(".action-bar").getByRole("button", { name: "Check" }).click();

      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "Check" }).click();

      await waitVisible(hostPage.getByText("Hand #1 · Turn"));

      // Undo #1: reverts Turn back to Flop with Seat 1 acting
      const undoBtn = hostPage.getByRole("button", { name: "Undo", exact: true });
      await undoBtn.click();
      await waitVisible(hostPage.getByText("Hand #1 · Flop"));
      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));

      // Undo #2: reverts Flop Seat 1 turn back to Flop Seat 3 turn
      await undoBtn.click();
      await waitVisible(p3Page.getByText("Your Action (Seat 3)"));

      /* 9. Check Flop, Turn, and River through to Showdown */
      for (const streetName of ["Flop", "Turn", "River"] as const) {
        await waitVisible(hostPage.getByText(`Hand #1 · ${streetName}`));
        await waitVisible(p3Page.getByText("Your Action (Seat 3)"));
        await p3Page.locator(".action-bar").getByRole("button", { name: "Check" }).click();

        await waitVisible(hostPage.getByText("Your Action (Seat 1)"));
        await hostPage.locator(".action-bar").getByRole("button", { name: "Check" }).click();
      }

      await waitVisible(hostPage.getByText("Hand #1 · Showdown"));

      /* 10. Test Undo from Showdown back to River, then replay Check to Showdown */
      await undoBtn.click();
      await waitVisible(hostPage.getByText("Hand #1 · River"));
      await waitVisible(hostPage.getByText("Your Action (Seat 1)"));
      await hostPage.locator(".action-bar").getByRole("button", { name: "Check" }).click();
      await waitVisible(hostPage.getByText("Hand #1 · Showdown"));

      /* 11. Resolve Showdown per-Pot in UI: Alice wins Main Pot (300), Charlie wins Side Pot 1 (100) */
      const mainPotBox = hostPage.locator(".action-bar", { hasText: "Main Pot · 300 Chips" });
      await waitVisible(mainPotBox);
      await mainPotBox.locator("button.showdown-option", { hasText: "Seat 1 · Alice" }).click();
      await mainPotBox.getByRole("button", { name: "Award Main Pot (300 Chips)" }).click();

      const sidePotBox = hostPage.locator(".action-bar", { hasText: "Side Pot 1 · 100 Chips" });
      await waitVisible(sidePotBox);
      await sidePotBox.locator("button.showdown-option", { hasText: "Seat 3 · Charlie" }).click();
      await sidePotBox.getByRole("button", { name: "Award Side Pot 1 (100 Chips)" }).click();

      await waitVisible(hostPage.getByText("Hand #1 Complete"));

      /* 12. Between Hands: Charlie (Seat 3) requests Early Cash-Out -> Host approves */
      await p3Page.getByRole("button", { name: "Request Early Cash-Out" }).click();
      await waitVisible(p3Page.getByText("Cash-Out Requested"));

      const pendingBox = hostPage.locator(".card", { hasText: "Pending Requests" });
      await waitVisible(pendingBox.getByText("Cash-Out"));
      await pendingBox.getByRole("button", { name: "Approve" }).first().click();

      await waitVisible(hostPage.getByText("Early Cash-Outs (1)"));
      // Seat 3 should now be open on p3Page after Cash-Out
      await waitForCondition(
        p3Page,
        async () => {
          const mineCount = await p3Page.locator(".seat-card.seat-mine").count();
          return mineCount === 0;
        },
        "Seat 3 opens for Player 3 after Cash-Out approval",
      );

      /* 13. Host settles Session -> verifies Zero-Sum Balanced Settlement & Transfers on mobile */
      await hostPage.getByRole("button", { name: "Settle Session" }).click();
      await hostPage.getByRole("button", { name: "Confirm Final Settlement" }).click();

      await waitVisible(hostPage.getByRole("heading", { name: "Session Settlement" }));
      await waitVisible(hostPage.getByText("Zero-Sum Balanced"));
      await waitVisible(hostPage.getByText("Cash Transfers"));
      await waitVisible(hostPage.getByText("Player Ledger Summary"));

      await waitVisible(hostPage.locator(".settlement-transfer-card").first());
      await waitVisible(p2Page.getByRole("heading", { name: "Session Settlement" }));
      await waitVisible(p2Page.getByText("Zero-Sum Balanced"));

      await assertNoHorizontalOverflow(hostPage, "Host Settlement");
      await assertNoHorizontalOverflow(p2Page, "Player 2 Settlement");
    } finally {
      await hostCtx.close();
      await p2Ctx.close();
      await p3Ctx.close();
    }
  });
});
