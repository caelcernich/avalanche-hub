# Avalanche Hub — self-hosted, auto-refreshing

A static site for Colorado Avalanche games, roster, and model win probabilities.
A GitHub Actions job refreshes schedule, scores, and Elo ratings every hour
from the NHL's free public API — no server, no API keys, no monthly cost.

## What updates automatically vs. by hand

| Data | Updates | How |
|---|---|---|
| Schedule, scores, standings-based Elo | Every hour | `scripts/refresh.mjs` via GitHub Actions |
| Roster (names, numbers, bio) | Every hour | same script |
| Injuries | Manual | edit `data.json` → `injuries.items`, or ask Claude |
| News feed | Manual | edit `data.json` → `news.items`, or ask Claude |
| Win probabilities / odds | Automatic (computed live from the above) | in `index.html`, no API needed |

## Deploy it (about 10 minutes, free)

1. **Create a repo.** On GitHub, create a new **public** repository (public
   keeps GitHub Actions completely free and unlimited — a private repo gets
   2,000 free minutes/month, which is still plenty for this, but public is
   simplest).
2. **Upload these files**, keeping the folder structure exactly as given:
   - `index.html`
   - `data.json`
   - `scripts/refresh.mjs`
   - `.github/workflows/refresh.yml`
   - `README.md`
   (Easiest: on the repo's GitHub page, use "Add file → Upload files" and
   drag the whole folder, or `git init && git add . && git commit -m "init" && git push`.)
3. **Turn on GitHub Pages.** Repo → Settings → Pages → under "Build and
   deployment," set Source to "Deploy from a branch," Branch to `main` and
   folder to `/ (root)`. Save. GitHub gives you a URL like
   `https://<your-username>.github.io/<repo-name>/` within a minute or two —
   that's the link anyone can open.
4. **Let the bot commit.** Repo → Settings → Actions → General → scroll to
   "Workflow permissions" → select **"Read and write permissions"** → Save.
   (Without this, the hourly job can update `data.json` but can't push the
   change back.)
5. **Test it now instead of waiting an hour.** Repo → Actions tab → "Hourly
   data refresh" → "Run workflow" → Run workflow. Watch it go green, then
   check `data.json` in the repo — it should show a new `lastRefreshed`
   timestamp along with real schedule/score data pulled live.

That's it — from here it runs itself every hour, forever, for $0.

## Notes and honest limitations

- **Odds are model-only, not sportsbook lines.** As requested, this skips
  paid odds APIs. The Elo model (seeded from 2025-26 standings, adjusted for
  home ice, injuries, and projected goalie) computes its own moneyline and
  puck line, clearly labeled as a model estimate.
- **Injuries and news are hand-maintained.** The NHL's public API doesn't
  expose either, and this project intentionally doesn't scrape other sites.
  Ask Claude any time to fetch the latest injury report or headlines and
  hand you an updated `data.json` snippet to paste in — or edit those two
  fields yourself.
- **Player-level trending/lagging** needs box-score data per game, which
  `refresh.mjs` doesn't pull yet (it tracks team-level results only, which
  is enough to keep Elo accurate). Ask Claude to extend the script if you
  want full per-player trending — it's a natural next step, just a bigger
  one.
- **Schedule delay:** GitHub's cron scheduler can occasionally run a few
  minutes late during high load (it's not a hard real-time guarantee) — the
  workflow is deliberately set to `:07` past the hour rather than `:00` to
  reduce that. If you ever see it stop firing entirely (rare, happens
  during GitHub-wide incidents), a manual "Run workflow" click always works
  as a fallback, and pushing any commit re-syncs the schedule.
- **NHL API field names:** the endpoints used (`api-web.nhle.com`) are
  free and don't require a key, but they're unofficial/undocumented. If a
  field ever comes back empty after an NHL-side change, the script logs a
  clear error in the Actions run log and leaves that section untouched
  rather than breaking the page — paste the error to Claude for a fix.
