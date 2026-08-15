/**
 * Diagnostic: force the page's dark theme, measure the strip text color and
 * the tooltip colors, and save a screenshot for visual inspection.
 */
const fs = require("fs");
const { chromium } = require("playwright-core");

const EXECUTABLE = process.env.PW_CHROME;
const URL = "http://127.0.0.1:3080/";
const TITLE = process.argv[2] ?? "写一个插件，我注意到这个DSH";
const OUT = process.argv[3] ?? "dark-diag.png";

(async () => {
	const browser = await chromium.launch({ ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}), headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForTimeout(6000);
	await page.evaluate((substr) => {
		const candidates = Array.from(document.querySelectorAll("[role='button'], button, div, li, span")).filter((el) => {
			const t = (el.textContent ?? "").trim();
			return t.includes(substr) && t.length < 120;
		});
		candidates.sort((a, b) => a.textContent.length - b.textContent.length);
		candidates[0]?.click();
	}, TITLE);
	await page.waitForSelector(".dsh-subagent-stats-root", { timeout: 90000 });
	await page.waitForTimeout(1500);

	// Force the dark theme marker and re-measure.
	const colors = await page.evaluate(() => {
		document.body.setAttribute("data-ds-dark-theme", "");
		const strip = document.querySelector(".dsh-subagent-stats-root");
		const stripStyle = getComputedStyle(strip);
		const strong = document.querySelector(".dsh-subagent-stats-strong");
		const bg = getComputedStyle(document.body).backgroundColor;
		const chatBg = getComputedStyle(strip.parentElement).backgroundColor;
		return {
			stripColor: stripStyle.color,
			stripBg: stripStyle.backgroundColor,
			stripFont: stripStyle.fontSize,
			strongColor: strong ? getComputedStyle(strong).color : null,
			bodyBg: bg,
			stripParentBg: chatBg
		};
	});

	// Hover to show the bubble, then screenshot.
	await page.hover(".dsh-subagent-stats-root");
	await page.waitForTimeout(1200);
	const bubbleColors = await page.evaluate(() => {
		const el = document.querySelector('div[role="tooltip"]');
		if (!el) return null;
		const s = getComputedStyle(el);
		const labels = Array.from(el.querySelectorAll("span")).filter((sp) => /主对话|子 agent|^·/.test(sp.textContent.trim())).slice(0, 3).map((sp) => getComputedStyle(sp).color);
		const strongs = Array.from(el.querySelectorAll("span")).filter((sp) => getComputedStyle(sp).fontWeight === "700").slice(0, 3).map((sp) => getComputedStyle(sp).color);
		return { bg: s.backgroundColor, color: s.color, labels, strongs };
	});
	const shot = await page.screenshot({ path: OUT });
	console.log(JSON.stringify({ colors, bubbleColors, screenshot: OUT }, null, 2));
	await browser.close();
})().catch((err) => {
	console.error("diagnostic failed:", err);
	process.exit(2);
});
