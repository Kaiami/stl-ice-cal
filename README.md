# St. Louis Ice Times — subscribable calendars

Turns the St. Louis skating schedule from [icetimestl.com](https://icetimestl.com)
into **subscribable calendar feeds** — one per rink, plus an "all rinks" feed —
that any calendar app (Apple Calendar, Google Calendar, Outlook) keeps up to date
automatically. People subscribe to a URL; they are **not** importing a one-off file.

A nightly GitHub Actions job re-reads the schedule and republishes the feeds, so
they track the source as it changes overnight.

## How it works

1. `build.mjs` fetches the schedule JSON from `https://icetimestl.com/api/schedule`
   (the same data the site's own page uses — a clean API, no HTML scraping).
2. It filters to the chosen session types, groups sessions by rink, and writes
   RFC-5545 `.ics` files plus a subscribe page into `public/`:

   | File | Calendar |
   |------|----------|
   | `all.ics` | every included session, all rinks (rink shown in each title) |
   | `centene.ics`, `crevecoeur.ics`, `greensfelder.ics`, `webster.ics`, `kennedy.ics`, `brentwood.ics`, `kirkwood.ics` | one per public rink |
   | `ccfsc.ics`, `stlsc.ics` | the two members-only figure-skating clubs' club ice |
   | `index.html` | a page of Subscribe / Copy-link buttons |
   | `feeds.json` | machine-readable list of what was built |

3. GitHub Actions (`.github/workflows/build.yml`) runs the build on a schedule
   (and on every push) and deploys `public/` to GitHub Pages. The subscribe URLs
   are then stable, e.g.

   ```
   https://<your-user>.github.io/<repo>/brentwood.ics      ← paste into Google/Outlook
   webcal://<your-user>.github.io/<repo>/brentwood.ics     ← one-tap on Apple/iPhone
   ```

   The subscribe page builds those links from its own address, so they are correct
   whatever you name the repo.

## Deploy (one time)

1. Create a new GitHub repo and push this folder to it:
   ```bash
   git add -A
   git commit -m "Initial commit: STL ice calendar feeds"
   git branch -M main
   git remote add origin https://github.com/<your-user>/<repo>.git
   git push -u origin main
   ```
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open the **Actions** tab and let the "Build and deploy ice calendars" workflow
   run (it runs on push; you can also hit **Run workflow**). When it finishes, the
   run shows the Pages URL.
4. Visit `https://<your-user>.github.io/<repo>/` — that's the subscribe page to
   share. Done; it now rebuilds nightly on its own.

## Refresh cadence

- This project **republishes** the feeds twice a day (09:15 and 19:15 UTC — edit
  the `cron` lines in the workflow to taste).
- Your **calendar app** decides how often it re-downloads a subscribed URL. Apple
  Calendar lets you pick (down to hourly); **Google Calendar refreshes on its own
  schedule — often only every several hours to a day**, which is a Google
  limitation, not something this feed controls.

## Customizing

- **Which session types** — edit the default in `build.mjs` or set an env var in
  the workflow: `INCLUDE_TYPES=public,freestyle,training,club_ice` (any subset).
- **Rink names** — edit `rinks.mjs` (display name + short tag per `rinkId`).
- **Fold club ice into a physical rink** — the two clubs (`ccfsc`, `stlsc`) are
  their own calendars by default. To instead route a club's sessions into a public
  rink's calendar, set that club's `foldInto` in `rinks.mjs` to the host `rinkId`
  (e.g. `foldInto: 'brentwood'`).

## Local testing (no deploy)

```bash
node build.mjs                                   # build from the live API (Node 18+)
# or, offline, from a saved copy of the data:
curl -s https://icetimestl.com/api/schedule -o sched.sample.json
npm run build:sample                             # ICE_SCHEDULE_FILE=./sched.sample.json
python3 -m http.server 8777 --directory public   # then open http://127.0.0.1:8777/
```

## Notes / caveats

- **Unofficial.** This mirrors a third-party aggregator; always confirm times with
  the rink before you go. Each event links back to icetimestl.com.
- The source API currently returns the full season (roughly Nov → May). If it ever
  narrows to a rolling window, the feeds narrow with it automatically.
- Times are stored in UTC with the source's own offsets, so daylight-saving is
  handled correctly; calendar apps display them in the viewer's local time.
