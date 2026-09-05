import "./playwright-env.js";
import { fetchMoxfieldViaBrowser, closeBrowser } from "./fetch-deck.js";
import { parseMoxfieldTarget } from "./moxfield-resource.js";

const raw = process.argv[2]?.trim();
const target = raw ? parseMoxfieldTarget(raw) : null;
if (!target) {
  console.error(
    "Usage: npm run fetch -- <publicId|url>\n" +
      "Example: npm run fetch -- 0lVXTNWWzU6LLsdT02x6Kg\n" +
      "         npm run fetch -- https://www.moxfield.com/collection/J4FAbt_MtEG8pj0wk3jZpg",
  );
  process.exit(1);
}

try {
  const { data, via, kind, publicId } = await fetchMoxfieldViaBrowser(target);
  const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const boards =
    rec?.boards && typeof rec.boards === "object" && !Array.isArray(rec.boards)
      ? (rec.boards as Record<string, { cards?: Record<string, unknown> }>)
      : null;
  const mainboardCards = boards?.mainboard?.cards;
  const rows = Array.isArray(rec?.data) ? rec.data : null;
  const user =
    rec?.user && typeof rec.user === "object"
      ? (rec.user as { displayName?: string; userName?: string })
      : null;
  const summary = rec
    ? {
        kind,
        publicId: typeof rec.publicId === "string" ? rec.publicId : publicId,
        name:
          typeof rec.name === "string"
            ? rec.name
            : user?.displayName ?? user?.userName ?? null,
        itemCount: rows
          ? rows.length
          : mainboardCards && typeof mainboardCards === "object"
            ? Object.keys(mainboardCards).length
            : rec.mainboard && typeof rec.mainboard === "object"
              ? Object.keys(rec.mainboard as object).length
              : typeof rec.totalResults === "number"
                ? rec.totalResults
                : 0,
      }
    : null;
  console.log(JSON.stringify({ via, summary }, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
