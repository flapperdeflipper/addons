# AI Usage Proxy: product and architecture plan

## Purpose

Evolve the existing Claude add-on into one `ai_usage_proxy` that connects to Claude, OpenAI/Codex, and z.ai, and supplies their subscription usage to MQTT displays. Its web page becomes the place to connect accounts, see whether monitoring works, and repair a connection when authorization expires.

The main design decision is to share the dashboard and monitoring infrastructure while giving each provider its own authentication lifecycle. Credentials are managed on the Home Assistant host, so monitoring continues when the user's computers and browser are closed.

## The web page

Use one Ingress dashboard named **AI Usage Proxy**, with a card for each provider. Three cards sit alongside each other when there is room and stack vertically on smaller screens. Follow the existing add-on's compact dark appearance, with readable progress bars, subdued diagnostics, and no frontend framework requirement.

The header shows the shared MQTT connection and a Settings link. MQTT is a separate status because account monitoring can work while publishing is interrupted. Each card shows:

- Provider name and connection badge.
- Available usage windows, each with percentage **used**, a progress bar, and next reset.
- Last successful update, plus a stale indicator when appropriate.
- Refresh usage and Manage connection actions.

An illustrative layout, with example values rather than real account readings:

```text
AI Usage Proxy                                  MQTT connected   Settings

┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│ Claude    Connected │ │ OpenAI    Connected │ │ z.ai   Not connected│
│                     │ │ Codex               │ │                     │
│ 5-hour     42% used  │ │ 5-hour     18% used  │ │ Connect your Coding │
│ ███████░░░░░░░░░░   │ │ ███░░░░░░░░░░░░░░   │ │ Plan to see usage.  │
│ Resets in 2h 14m    │ │ Resets in 3h 40m    │ │                     │
│ Weekly     67% used  │ │ Weekly     35% used  │ │                     │
│ ███████████░░░░░░   │ │ ██████░░░░░░░░░░░   │ │                     │
│ Resets Friday 09:00 │ │ Resets Monday 11:00 │ │                     │
│                     │ │                     │ │                     │
│ Updated 12s ago     │ │ Updated 8s ago      │ │                     │
│ Refresh     Manage  │ │ Refresh     Manage  │ │ Connect             │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

Window names and durations come from the provider. The example does not establish that every subscription exposes these exact windows. Additional quotas appear under “More usage windows” within the relevant card. Unknown reset times show “Reset time unavailable”; missing percentages show “Usage unavailable”. Percentages and labels remain visible together so a display cannot confuse used with remaining allowance.

**Manage connection** expands a panel inside that card. It shows account/plan information when available, connection health, Reconnect or Replace key, and Disconnect. It never shows access tokens, refresh tokens, or the saved API key. Technical MQTT topics belong in an expandable details section rather than the main connection flow.

The browser updates public status every five seconds without reloading the page or replacing an open form. These requests read cached state; they do not poll providers. Provider polling runs independently on the server, initially using the existing 60-second interval. A page left open must not lose pasted authorization codes or restart login flows.

Settings opens a compact panel showing the polling interval, MQTT connection source, topic root, and Home Assistant discovery setting, with a link to the add-on configuration for edits. Home Assistant add-on options remain the source of truth for shared settings; provider credentials are managed in their connection panels. The dashboard does not introduce a second broker-password store.

## Three connection flows inside one web app

Home Assistant Ingress controls access to the page. Connecting a provider authorizes the add-on to read that provider's usage; each connection is independent. Initially there is one account per provider, shared by all displays and by administrators viewing this add-on.

The providers do not require identical sign-in forms:

| Provider | Connect panel | How it completes | Ongoing credential management |
| --- | --- | --- | --- |
| Claude | Authorization link and a field for the returned `code#state` | The add-on exchanges the pasted code using its pending PKCE flow | Claude adapter refreshes and persists rotating tokens |
| OpenAI / Codex | Verification link, device code, and waiting status | User approves on OpenAI's page; Codex reports login completion | Codex manages its private authentication state and refresh lifecycle |
| z.ai | Masked Coding Plan key field and Save and test button | The add-on validates the key with a usage request | Saved key is reused until it is replaced or rejected |

Claude's flow already exists in this repository. OpenAI documents the device-code/account interface in [Codex app-server](https://learn.chatgpt.com/docs/app-server); device login can require enabling an account/workspace setting, which the panel should explain if unavailable. See [headless authentication](https://learn.chatgpt.com/docs/auth). z.ai's published usage tooling uses a configured credential, and its [key management guide](https://docs.z.ai/devpack/notice/api-key-management) distinguishes Coding Plan keys from Standard API keys. An OAuth flow for z.ai is not established by these sources.

### Claude: preserve the working renewal experience

Clicking Connect starts a Claude-specific pending authorization and expands this panel:

```text
Connect Claude
1. [Open Claude authorization]
2. Approve access and copy the code shown on the callback page.
3. [ code#state                                      ]
   [Connect]   [Cancel]
```

The authorization page opens separately, leaving the dashboard available. Submission returns an inline result in the same card. An invalid or expired code leaves the panel open with a specific retry message. Successful token exchange persists the returned credentials immediately, then checks usage. A temporary usage error after exchange must not discard the newly issued refresh token.

Keep the current provider's PKCE/state convention, including its existing state/verifier binding. The provider's callback currently displays a code for the user to paste; the design does not assume that it can redirect to a Home Assistant Ingress URL.

### OpenAI: device authorization suits a headless add-on

Clicking Connect asks a private Codex app-server process to start device authorization. The card becomes:

```text
Connect OpenAI / Codex
[Open verification page]
Enter this code: ABCD-1234                 [Copy]
Waiting for approval…
[Cancel]
```

Codex's login-completed event updates the card without a page reload. On success, the service reads account and usage information and switches to the normal usage view. Cancellation, expiry, or unavailable device login leaves a clear Retry action.

This avoids needing an OpenAI browser callback to reach the user's Home Assistant host. The add-on uses its own persistent Codex state directory. It does not depend on copying credentials from a computer, watching local desktop sessions, or running a model request just to measure usage.

### z.ai: validate a subscription key

Clicking Connect shows a masked field labeled **Coding Plan API key**, a link to the provider's key-management page, and **Save and test**. Explain where the subscription key comes from in that panel.

The adapter performs a quota request before accepting a replacement key. A rejected key keeps the existing saved key intact. A valid credential with an unsupported quota response gets a separate “Connected; usage format unsupported” message; it must not be reported as bad credentials. A successful replacement clears readings from the previous connection and fetches fresh data. Never return the saved key to the browser.

## How authentication stays separate

A small connection manager tracks one connection per provider. Each provider supplies its own authentication driver and public connection view. The web layer renders three supported interaction types: authorization-code entry, device authorization, and credential entry.

Routes are scoped by provider, for example:

```text
POST /providers/claude/connect
POST /providers/claude/complete
POST /providers/openai/connect
POST /providers/openai/cancel
POST /providers/zai/credentials
POST /providers/<provider>/disconnect
POST /providers/<provider>/refresh
GET  /api/status
```

All paths respect the Ingress prefix. Provider/action combinations are explicitly registered; a generic route cannot invoke arbitrary adapter methods. State-changing forms carry an application form token, and credential submissions stay out of URLs and logs.

Every pending login has a provider ID, an opaque flow ID, a creation time, and its provider-specific state. Claude retains its PKCE verifier; OpenAI retains Codex's login ID. A completion must match both its provider and current flow. A Claude code therefore cannot complete an OpenAI connection, and a late OpenAI event cannot overwrite a later connection attempt.

Allow one pending flow per provider. Reopening an active flow returns its current state; starting over explicitly cancels or invalidates the previous flow. Separate providers can connect simultaneously. Pending login state expires and is abandoned on application restart; established credentials survive. Multiple tabs see the same connection state and receive a useful message if another tab has replaced their flow.

Public status and transient login details are separate views. The normal dashboard response contains connection state, usage, and safe messages. The active connection panel retrieves its own flow information. Token exchange responses and secret storage objects never become UI models.

## Token renewal and recovery

Refreshing usage, refreshing credentials, and reconnecting an account are distinct operations. **Refresh usage** schedules a reading; it does not ask the user to sign in again or override an upstream rate-limit delay.

| Situation | Backend behavior | What the card shows |
| --- | --- | --- |
| Claude access token approaches expiry | Refresh once under the provider lock; atomically save rotated tokens before further use | Connected; no user action |
| Claude usage rejects an access token | Attempt one credential refresh and retry; require reconnection if authorization is revoked | Reconnect only when renewal fails |
| OpenAI credentials need renewal | Codex owns refresh; adapter maps an unrecoverable auth failure to reconnect-required | Connected during normal renewal; Reconnect on failure |
| z.ai key is rejected | Stop repeatedly retrying the rejected credential and wait for replacement | Key rejected; Replace key |
| Network/provider outage | Keep credentials and last valid sample; retry with backoff | Temporarily unavailable; last known usage and sample age |
| Provider rate limit | Honor retry delay; coalesce manual refresh requests | Updates paused; next retry when known |
| Quota exhausted | Keep monitoring with valid credentials | Usage limit reached, with reported reset time |
| Application restart | Reload established connections; resume monitoring | Checking connection, then the resulting state |

Connection state and reading health are separate. A valid account can have stale readings, and exhausted usage does not mean expired authorization. After three missed normal polling intervals, mark data stale. Keep its last-known values visibly labeled; do not publish them as a fresh successful update.

Store Claude and z.ai credentials in separate private provider directories. Give Codex its own private persistent state directory and let it own its credential files. Use atomic writes for stores owned by this application, private file permissions, and one credential writer per provider. Disconnect clears that provider's local credentials and cached readings and cancels its pending login. The panel describes it as disconnecting this proxy; it must not imply revocation of every session at the provider.

## Provider architecture

The shared application has four responsibilities:

1. **Connections:** route provider actions and maintain public connection state.
2. **Monitoring:** schedule independent provider workers and retain the latest readings.
3. **Presentation:** render the dashboard and its connection panels from public views.
4. **Publishing:** translate normalized readings into MQTT and Home Assistant entities.

Each adapter owns authentication, upstream requests, response interpretation, and provider-specific errors. A normalized usage window contains a stable ID, quota-bucket ID, label, percentage used, duration, and next reset; duration/reset may be absent. Preserve multiple buckets rather than merging unrelated allowances.

Adding another provider means registering an adapter, its configuration, and its authentication interaction type. A provider using one of the three existing interaction types needs no new page. A genuinely different sign-in mechanism adds a connection-panel component while leaving scheduling, usage cards, and publishing intact.

Keep the existing Python service, paho-mqtt, and lightweight HTML, with a small JavaScript status updater. The OpenAI adapter uses a pinned Codex app-server executable over private stdio. This is the main new runtime dependency and needs an Alpine container compatibility check. Each provider runs independently so a stalled login or HTTP request cannot freeze the web page or another provider's updates.

## MQTT and the physical displays

Use `ai/usage/<provider>/...` as the common namespace. Publish a retained JSON state plus straightforward numeric topics for each window. Include status, last successful update, actual window duration, and reset epoch where known. Provide session/week convenience aliases only when those windows can be identified reliably.

Continue publishing the existing configured Claude topics, such as `claude/usage/session_percent` and `claude/usage/week_percent`, so the current displays do not need an immediate firmware update. Preserve Claude Home Assistant discovery identities; add separate entities for OpenAI and z.ai.

Show the relevant topics in each card's details panel, with copy buttons. The dashboard manages connections and verifies readings; each physical display subscribes to the providers/windows it needs. Display firmware changes are a separate scope unless requested.

Publishing needs both process availability and per-provider freshness. Home Assistant must show an OpenAI sensor as healthy when only Claude needs reconnection. Retained values removed by a disconnected account or disappearing window must be cleared; temporary polling failures retain the last sample with unavailable/stale status.

## Rename and migration

Rename the existing directory, display name, application naming, image, and slug to `ai_usage_proxy` equivalents, keeping a single add-on manifest in the repository.

A slug change changes Home Assistant's installed identity, so this requires an explicit installation/data migration rather than a claim of automatic in-place upgrade. Transfer existing options and Claude credentials through a private migration procedure, stop the old service before starting the renamed service, and convert the legacy `/data/tokens.json` into the Claude provider store. A fresh installation can instead connect Claude through the dashboard. The implementation must document the supported transfer method and rollback before release. [Home Assistant identity rules](https://contributors.home-assistant.io/apps/how-apps-work/).

After migration, the first dashboard visit shows Claude's existing connection and readings, with OpenAI and z.ai ready to connect. It does not force the user through all three setup flows. Existing MQTT broker discovery/manual fallback options remain available.

## Delivery strategy

**First, prove the dashboard and connection model with Claude.** Rename the application, extract its existing provider, and build the three-card page with working Claude connection management. This validates the UI, renewal behavior, and MQTT compatibility against an already-working integration.

**Then add OpenAI end to end.** Verify the pinned executable in the container, connect through the device panel, restore the connection after restart, and publish actual account windows. Validate this before introducing z.ai's schema uncertainty.

**Then add z.ai against a verified response.** Its first-party tool establishes the quota endpoint, but the current credit/reset schema needs a sanitized response from the target plan. Establish the mappings and test them before presenting session/weekly readings as supported. [Pinned first-party usage script](https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs).

**Finally validate the combined experience.** Exercise simultaneous connection attempts, expired login flows, token rotation, rejected keys, outages, restart, and MQTT reconnect. Check that none disrupts another provider, typed input survives status updates, credentials never appear in page responses, and display readings agree with provider usage pages. Cover these behaviors with isolated tests and a built-container check, followed by live checks after accounts are connected.

The result is complete when one dashboard can establish, maintain, and repair all three supported connections, and the displays receive independent, correctly labeled usage windows without depending on an open browser or desktop session.
