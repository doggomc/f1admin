# Streams and Discord

The Discord bot does not relay audio or video and does not join voice channels.
The optional voice-relay feature and its `/watchparty` command have been removed.

The bot's other features remain available: session alerts, driver-role and alert
panels, configuration and status commands, test alerts, emoji management, and
`/website`. Those posts link members to FreeF1, where stream playback happens
in the visitor's browser rather than passing through Render.

Discord bots cannot use the client-only Go Live feature to send video into a
voice channel. To watch, open the **Watch on FreeF1** link in an alert or use
`/website`. See [`README.md`](README.md) for bot setup and commands.
