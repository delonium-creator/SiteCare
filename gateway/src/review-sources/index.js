// Registry of review-source adapters. Adding a future service (of the ~50
// beyond this initial set) is one new file here plus one line below --
// no schema, sync-job, dialog or public-endpoint change required.
import * as dgis from "./dgis.js";
import * as profi from "./profi.js";
import * as flamp from "./flamp.js";
import * as tbank from "./tbank.js";
import * as yandexMaps from "./yandex-maps.js";

export const REVIEW_SOURCES = Object.freeze({
  [dgis.key]: dgis,
  [profi.key]: profi,
  [flamp.key]: flamp,
  [tbank.key]: tbank,
  [yandexMaps.key]: yandexMaps
});

export function reviewSourceCatalog() {
  return Object.values(REVIEW_SOURCES).map((source) => ({
    key: source.key,
    label: source.label,
    identifierHint: source.identifierHint
  }));
}
