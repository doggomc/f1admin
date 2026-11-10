
### Stream relay switch

Race Control → Source manager → **Disable stream relays** immediately blocks the stripped player documents and their Weellz keys and StreamFree/PPV playlist endpoints. Re-enable the switch to restore them. The saved source list and Auto-Streams setting are not changed. The current frontend hides stripped sources while disabled, stops active relayed players, and uses a direct StreamFree player for Sky HD. Other Streams uses provider embeds directly regardless of this switch. Direct players may show provider ads.

This switch covers stream-player/playlist/key relays, not all HTTP traffic: normal site configuration, admin operations, metadata discovery, health checks and provider playback still make requests. Old/cached frontend versions and in-flight requests can still reach the server briefly; blocked requests return 503 without starting a relay fetch. Deploy the accompanying frontend change as well as the backend change.
