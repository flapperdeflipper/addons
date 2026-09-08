# SlopClanker add-on

The application is developed and released in the project repository:
**[flapperdeflipper/slopclanker](https://github.com/flapperdeflipper/slopclanker)** —
see its README and [DOCS.md](https://github.com/flapperdeflipper/slopclanker/blob/master/DOCS.md)
for the full API/MCP reference and changelog.

This add-on wraps the released container with Home Assistant Supervisor
plumbing: options (`token` via `!secret slopclanker_token`,
`heartbeat_timeout`), port 8090, and `/data` persistence.
