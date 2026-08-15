/**
 * E2E for the settings card: per-group toggles (strip + tooltip), bubble
 * color customization (color picker + RGB), persistence across reload, reset.
 *
 * Usage: node e2e-settings.cjs <session-title-substring>
 */
const { chromium } = require("playwright-core");

const EXECUTABLE = process.env.PW_CHROME;
const URL = "http://127.0.0.1:3080/";
const TITLE = process.argv[2] ?? "写一个插件，我注意到这个DSH";

(async () => {
	const browser = await chromium.launch({ ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}), headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const consoleErrors = [];
	const pageErrors = [];
	page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
	page.on("pageerror", (err) => pageErrors.push(String(err)));

	const openSession = async () => {
		await page.waitForTimeout(500);
		await page.evaluate((substr) => {
			const candidates = Array.from(document.querySelectorAll("[role='button'], button, div, li, span")).filter((el) => {
				const t = (el.textContent ?? "").trim();
				return t.includes(substr) && t.length < 120;
			});
			candidates.sort((a, b) => a.textContent.length - b.textContent.length);
			candidates[0]?.click();
		}, TITLE);
		await page.waitForSelector(".dsh-subagent-stats-root", { timeout: 60000 });
		await page.waitForTimeout(800);
	};
	const openSettings = async () => {
		// Sidebar footer "设置" button.
		await page.evaluate(() => {
			const candidates = Array.from(document.querySelectorAll("[role='button'], button")).filter((el) => {
				const t = (el.textContent ?? "").trim();
				return t === "设置" || t === "Settings";
			});
			candidates[candidates.length - 1]?.click();
		});
		await page.waitForSelector('[data-stats-toggle="strip.counts"]', { timeout: 30000 });
	};
	const closeSettings = async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const stillOpen = await page.evaluate(() => !!document.querySelector('[data-stats-toggle="strip.counts"]'));
			if (!stillOpen) break;
			if (attempt === 0) {
				await page.keyboard.press("Escape");
			} else if (attempt === 1) {
				await page.evaluate(() => {
					// Click the full-viewport fixed overlay that is NOT the
					// settings panel itself (the drawer's dismissal mask).
					const overlay = Array.from(document.querySelectorAll("div")).find((el) => {
						const r = el.getBoundingClientRect();
						return r.width === window.innerWidth && r.height === window.innerHeight
							&& getComputedStyle(el).position === "fixed"
							&& getComputedStyle(el).pointerEvents !== "none"
							&& el.querySelector('[data-stats-toggle]') === null;
					});
					overlay?.click();
				});
			} else {
				await page.evaluate(() => {
					const candidates = Array.from(document.querySelectorAll("[role='button'], button")).filter((el) => {
						const t = (el.textContent ?? "").trim();
						return t === "设置" || t === "Settings";
					});
					candidates[candidates.length - 1]?.click();
				});
			}
			await page.waitForTimeout(700);
		}
	};
	const stripLine = async () => (await page.textContent(".dsh-subagent-stats-root")).trim();

	await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForTimeout(6000);
	await openSession();
	const baseline = await stripLine();

	// ── 1) Toggle strip.counts OFF, verify the strip drops 轮/步 ──
	await openSettings();
	await page.uncheck('[data-stats-toggle="strip.counts"]');
	await closeSettings();
	const afterToggle = await stripLine();
	const countsGone = !/轮|步|turns|steps/.test(afterToggle);

	// ── 2) Bubble background color via the color picker ──
	await openSettings();
	await page.evaluate(() => {
		const el = document.querySelector('[data-stats-color="bubble"]');
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		setter.call(el, "#ff00aa");
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await closeSettings();
	await page.hover(".dsh-subagent-stats-root");
	await page.waitForTimeout(1200);
	const bubbleBg = await page.evaluate(() => {
		const el = document.querySelector('div[role="tooltip"]');
		return el ? getComputedStyle(el).backgroundColor : null;
	});
	const colorApplied = bubbleBg === "rgb(255, 0, 170)";
	await page.mouse.move(10, 10); // leave

	// ── 3) Persistence across reload ──
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(6000);
	await openSession();
	await openSettings();
	const persisted = await page.evaluate(() => {
		const toggle = document.querySelector('[data-stats-toggle="strip.counts"]');
		const color = document.querySelector('[data-stats-color="bubble"]');
		return { countsChecked: toggle ? toggle.checked : null, bubbleColor: color ? color.value : null };
	});
	const persistedOk = persisted.countsChecked === false && persisted.bubbleColor === "#ff00aa";

	// ── 4) Reset ──
	await page.click('[data-stats-reset]');
	await page.waitForTimeout(300);
	const afterReset = await page.evaluate(() => {
		const toggle = document.querySelector('[data-stats-toggle="strip.counts"]');
		const color = document.querySelector('[data-stats-color="bubble"]');
		return { countsChecked: toggle ? toggle.checked : null, bubbleColor: color ? color.value : null };
	});
	const resetOk = afterReset.countsChecked === true && afterReset.bubbleColor === "#6a6e78";

	console.log(JSON.stringify({
		ok: countsGone && colorApplied && persistedOk && resetOk && consoleErrors.length === 0 && pageErrors.length === 0,
		baseline,
		afterToggle,
		countsGone,
		bubbleBg,
		colorApplied,
		persisted,
		persistedOk,
		afterReset,
		resetOk,
		consoleErrors,
		pageErrors
	}, null, 2));
	await browser.close();
	process.exit(countsGone && colorApplied && persistedOk && resetOk && consoleErrors.length === 0 && pageErrors.length === 0 ? 0 : 1);
})().catch((err) => {
	console.error("E2E settings failed:", err);
	process.exit(2);
});
