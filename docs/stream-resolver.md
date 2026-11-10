# Stream resolver map

`stream-resolver.js` is the backend's provider catalogue, resolver and relay implementation. The public cockpit still plays provider embeds; a successful resolver response or player shell does **not** prove that video is currently playing.

## Main sections

- **Catalogue:** `STREAM_SOURCES` declares stable source IDs, provider, language, group and shipped links. `listSources()` combines these with current provider information. `chipAddresses()` supplies the admin's address report.
- **EMB:** `embdlolChannels()` normalizes provider names and maps live channels to chips; `resolveUhdUrl()` handles 4K and its short cache. If dated recordings and a non-recording row are both reported, the non-recording row wins regardless of list order. A recording may remain as a fallback if it is the only match.
- **Weelo:** `weeloState()` reads the provider's feed status; `weeloUp()` distinguishes live, soon, off and unknown. Stripped Weelo HTML and keys have separate caches.
- **PPV:** `taifoodChannels()` reads and filters the live catalogue, with fallback mirrors. PPV master/sub-playlist helpers validate allowed hosts and paths; media segments remain upstream.
- **StreamFree:** `mirrorsFor()` discovers Sky HD mirrors. The stripped Sky HD helpers fetch and rewrite only permitted variants. Separately, Other Streams uses StreamFree's direct, unstripped embeds in the frontend.
- **Dynamic and health:** `resolveDynamic()` permits only known dynamic paths and caches short-lived player URLs briefly. `getHealth()` probes player shells and caches results; it is not a playback test.
- **HTTP layer:** `server.js` owns routes, CORS, relay origin restrictions, response caching and single-flight guards. Do not treat these browser-origin checks as authentication or relax them merely to test streams.

Caches, timeouts and URL allowlists are declared near the top of the resolver. A custom admin URL can override a shipped source; changing the catalogue does not overwrite that setting.

## Verification

Run `SITE_DIR=/path/to/frontend npm run check`. `scripts/stream-resolver-check.js` covers catalogue integrity, EMB duplicate precedence, 4K selection, caching and dynamic path rejection. The smoke tests exercise mock PPV, Weelo, EMB and StreamFree paths, playlist rewriting, admin reporting and relay policies. Frontend tests cover player selection separately.

When testing real providers, distinguish (1) API or catalogue reachable, (2) player document reachable, and (3) actual video playback. Offline events, expiring tokens, CORS, provider restrictions and browser autoplay can prevent playback even when a shell answers HTTP 200. Do not claim a feed plays unless a browser playback check confirms it.
