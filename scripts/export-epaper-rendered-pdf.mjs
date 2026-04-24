import puppeteer from "puppeteer";

const URL = "http://127.0.0.1:5180/e-paper";
const OUTPUT = "public/epaper-rich.pdf";

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 2200, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 120000 });

  // Trigger viewport-based diagram animations/lazy sections.
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const max = document.body.scrollHeight - window.innerHeight;
    let y = 0;
    while (y < max) {
      y = Math.min(y + 900, max);
      window.scrollTo(0, y);
      await sleep(180);
    }
    window.scrollTo(0, 0);
    await sleep(600);
  });

  await page.pdf({
    path: OUTPUT,
    format: "A4",
    printBackground: true,
    margin: { top: "10mm", right: "8mm", bottom: "12mm", left: "8mm" },
  });

  console.log(`Generated rendered e-paper PDF at ${OUTPUT}`);
} finally {
  await browser.close();
}
