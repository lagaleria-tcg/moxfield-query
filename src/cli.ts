import { fetchMoxfieldDeckViaBrowser, closeBrowser } from "./fetch-deck.js";

const publicId = process.argv[2]?.trim();
if (!publicId) {
  console.error(
    "Usage: npm run fetch -- <publicId>\nExample: npm run fetch -- 0lVXTNWWzU6LLsdT02x6Kg",
  );
  process.exit(1);
}

try {
  const { deck, via } = await fetchMoxfieldDeckViaBrowser(publicId);
  const d = deck && typeof deck === "object" ? (deck as Record<string, unknown>) : null;
  const boards =
    d?.boards && typeof d.boards === "object" && !Array.isArray(d.boards)
      ? (d.boards as Record<string, { cards?: Record<string, unknown> }>)
      : null;
  const mainboardCards = boards?.mainboard?.cards;
  const summary = d
    ? {
        name: typeof d.name === "string" ? d.name : null,
        publicId: typeof d.publicId === "string" ? d.publicId : null,
        mainboardCount:
          mainboardCards && typeof mainboardCards === "object"
            ? Object.keys(mainboardCards).length
            : d.mainboard && typeof d.mainboard === "object"
              ? Object.keys(d.mainboard as object).length
              : 0,
      }
    : null;
  // Compact CLI output (full payload is huge).
  console.log(JSON.stringify({ via, summary }, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
