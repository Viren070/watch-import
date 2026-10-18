# Watch Import

An AIOStreams addon that brings your watch history, Continue Watching and library from
**Stremio** or **Nuvio** into AIOStreams, through the
[`watch_state` resource](https://docs.aiostreams.viren070.me/reference/addon-protocol/watch-state).
AIOStreams keeps reading it, so what you watch there keeps showing up. It only reads:
nothing is ever written back to Stremio or Nuvio.

Built on [`@aiostreams/addon-sdk`](https://github.com/AIOStreams/addon-sdk).

## What it brings in

| AIOStreams                     | From Stremio                               | From Nuvio                              |
| ------------------------------ | ------------------------------------------ | --------------------------------------- |
| Resume points                  | Items in Continue Watching with a position | The profile's watch progress            |
| Watched films                  | Films watched at least once                | Watched films                           |
| Watched episodes               | Each show's watched episodes               | Watched episodes                        |
| Next Up                        | The episode Continue Watching points at    | The latest episode watched in each show |
| Favourites, when library is on | The library                                | The profile's library                   |

## Using it

1. Open `/configure`, choose Stremio or Nuvio and sign in. Your password goes from the
   page to Stremio or Nuvio directly. Stremio also signs in with a link code, which works
   for accounts made with Google or Facebook. For Nuvio, choose the profile to import.
2. Create the addon URL. The page shows what a first read finds.
3. In AIOStreams, go to **Addons → Installed**, click **Add by URL** and paste it.
   AIOStreams reads it in the background, and straight away when an app opens Continue
   Watching or Next Up.

For a **one-time import**, wait for the page's summary to report everything read, and
remove the addon once AIOStreams' Trackers tab shows a successful read. What was
imported stays.

## Running it

With Docker, using the image built from `main` for amd64 and arm64:

```yaml
services:
  watch-import:
    image: ghcr.io/viren070/watch-import:latest
    init: true
    restart: unless-stopped
    ports:
      - 7007:7007
    env_file:
      - .env
    volumes:
      - ./data:/app/data
```

Put `SECRET_KEY` in `.env` beside it (`openssl rand -hex 32`). The `data` folder holds
Nuvio sign-ins, so keep it across updates.

From source, with Node 24 and pnpm:

```sh
pnpm install
cp .env.example .env   # set SECRET_KEY
pnpm build
pnpm start
```

`pnpm dev` runs from source with reloads.

| Variable                   | Default | Meaning                                                                                              |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `SECRET_KEY`               |         | Required. Encrypts the session inside each addon URL; changing it invalidates every URL.             |
| `PORT`                     | `7007`  |                                                                                                      |
| `LOG_LEVEL`                | `info`  | `debug` logs each request.                                                                           |
| `DATA_DIR`                 | `data`  | Where Nuvio sign-ins are kept. Losing it means Nuvio users sign in again.                            |
| `ALLOW_PRIVATE_ADDON_URLS` | `false` | Lets the server fetch meta from addons on private addresses. Keep it off on a public instance.       |
| `PULL_BUDGET_SECONDS`      | `15`    | How long a read may spend before answering without the watched history. AIOStreams waits 20 seconds. |

Behind a login proxy such as Authelia, protect only `/configure` and `/`: AIOStreams
reads every other path without signing in.

## Sign-ins

- **Stremio** sessions last until you sign out, so the session is kept inside the addon
  URL, encrypted with `SECRET_KEY`.
- **Nuvio** sessions are renewed as they go, so the server keeps each one in `DATA_DIR`,
  encrypted with a key that only its addon URL holds: neither the file nor the URL works
  alone. Sessions nothing has read for 90 days are deleted. Run one instance, since the
  sessions live on its disk.

## How Stremio episodes are read

Stremio stores a show's watched episodes as a bitfield ordered by the show's episode
list, so reading one needs the same list Stremio used. The addon asks the meta addons in
the account's own Stremio collection, in the account's order, as Stremio does, and falls
back to Cinemeta and the Kitsu addon.

The first read of a large library fetches every show's episode list. A read that runs
out of time answers without the watched history (which AIOStreams treats as "no
information", not "nothing watched") and keeps fetching, so a later read is complete.
Nuvio stores episodes by number, so its reads need no episode lists.

## Hosting it publicly

The addon is built to be shared by many AIOStreams instances and users:

- **Private addresses.** Episode lists come from the meta addons in each user's own
  Stremio collection, so the server fetches URLs its users choose. With
  `ALLOW_PRIVATE_ADDON_URLS` off, any connection to a loopback, private, link-local or
  CGNAT address is refused at connect time, whether it is named directly, behind a DNS
  name or reached through a redirect. Such an addon, or one whose host no longer
  exists, is skipped as if it had no meta, and the next addon in the collection is
  used instead.
- **Service traffic.** Each account is checked for changes at most once every 10
  seconds, however often its URL is called, and only read in full when something has
  changed: Stremio by its library's modification times, Nuvio by its change cursors. A
  read made within a minute of a full one is answered from memory.
- **Fairness.** Stremio episode lists are fetched at most 32 at a time, and at most 4 at
  a time for any one account, so a large first import does not hold up anyone else. A
  host that keeps failing is skipped for two minutes after five failures.
- **Memory.** Libraries are not kept. Per account the server holds a fingerprint of
  what it read, the in-progress items, and the last full answer for a minute. Episode
  lists are cached for up to 5,000 titles.

Requests are not rate-limited per client, so put the server behind a reverse proxy that
does that.
