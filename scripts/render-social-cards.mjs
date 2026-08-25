// Renders docs/assets/social/*.svg to 2x PNGs in docs/assets/social/png/.
// Usage: node scripts/render-social-cards.mjs
import {mkdirSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {chromium} from "@playwright/test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const socialDirectory = join(repositoryRoot, "docs/assets/social");
const outputDirectory = join(socialDirectory, "png");

const cards = [
  {name: "pi-article", width: 1200, height: 675},
  {name: "cloudflare-artifacts-article", width: 1200, height: 675},
  {name: "multi-cloud-article", width: 1200, height: 675},
  {name: "pi-square", width: 1080, height: 1080},
  {name: "cloudflare-artifacts-square", width: 1080, height: 1080},
  {name: "multi-cloud-square", width: 1080, height: 1080},
];

mkdirSync(outputDirectory, {recursive: true});
const browser = await chromium.launch();
for (const card of cards) {
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: {width: card.width, height: card.height},
  });
  await page.goto(pathToFileURL(join(socialDirectory, `${card.name}.svg`)).href);
  const outputPath = join(outputDirectory, `${card.name}.png`);
  await page.locator("svg").screenshot({path: outputPath});
  await page.close();
  console.log(`rendered ${outputPath}`);
}
await browser.close();
