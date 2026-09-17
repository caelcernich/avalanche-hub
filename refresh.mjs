// Hourly data refresh for Avalanche Hub.
// Pulls schedule, scores, standings and roster from the NHL's free public
// web API (api-web.nhle.com — no key required) and updates data.json.
//
// Deliberately NOT automated here: injuries and the news feed. The public
// NHL API doesn't expose either, and scraping other sites' pages isn't
// something this script does. Edit data.json's "injuries" and "news"
// sections by hand (or ask Claude to help) whenever you want those refreshed
// — this job will not overwrite your edits to those two sections.

import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");
const TEAM = "COL";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "avalanche-hub-refresh/1.0" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function heightStr(inches) {
  if (!inches) return "—";
  return `${Math.floor(inches / 12)}-${inches % 12}`;
}

function ageFromDob(dob) {
  if (!dob) return "—";
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / 3.15576e10); // ms per average year
}

async function refreshStandings(data) {
  const st = await fetchJson("https://api-web.nhle.com/v1/standings/now");
  const rows = st.standings || [];
  if (!rows.length) return;
  const avgPts = rows.reduce((s, r) => s + (r.points || 0), 0) / rows.length;
  for (const row of rows) {
    const abbr = row.teamAbbrev?.default;
    if (!abbr) continue;
    const elo = Math.round(1500 + ((row.points || 0) - avgPts) * 3);
    if (abbr === TEAM) data.team_col.elo = elo;
    else if (data.opponents[abbr]) data.opponents[abbr].elo = elo;
  }
}

async function refreshRoster(data) {
  const r = await fetchJson(`https://api-web.nhle.com/v1/roster/${TEAM}/current`);
  const mapPlayer = (p, pos) => ({
    num: p.sweaterNumber ?? "—",
    name: `${p.firstName?.default || ""} ${p.lastName?.default || ""}`.trim(),
    pos,
    shot: p.shootsCatches || "—",
    ht: heightStr(p.heightInInches),
    wt: p.weightInPounds || "—",
    age: ageFromDob(p.birthDate),
    birthplace: [p.birthCity?.default, p.birthStateProvince?.default || p.birthCountry?.default]
      .filter(Boolean).join(", "),
    status: "Healthy",
    note: "",
  });
  const players = [
    ...(r.forwards || []).map((p) => mapPlayer(p, p.positionCode || "F")),
    ...(r.defensemen || []).map((p) => mapPlayer(p, "D")),
    ...(r.goalies || []).map((p) => mapPlayer(p, "G")),
  ];
  if (!players.length) return;
  // Carry forward any hand-set status/note (e.g. an injury flag) by name match,
  // since the NHL roster endpoint doesn't report injury status.
  const prevByName = Object.fromEntries((data.roster.players || []).map((p) => [p.name, p]));
  for (const p of players) {
    const prev = prevByName[p.name];
    if (prev) { p.status = prev.status; p.note = prev.note; }
  }
  data.roster.players = players;
}

async function refreshScheduleAndElo(data) {
  const sched = await fetchJson(`https://api-web.nhle.com/v1/club-schedule-season/${TEAM}/now`);
  const games = sched.games || [];
  if (!games.length) return;

  data.eloProcessedGameIds = data.eloProcessedGameIds || [];
  const byKey = Object.fromEntries((data.schedule.games || []).map((g) => [g.id, g]));
  const K = data.model_config?.kFactor || 20;
  const hfa = data.model_config?.homeAdvantageElo || 40;

  for (const g of games) {
    const isHome = g.homeTeam?.abbrev === TEAM;
    const oppAbbr = isHome ? g.awayTeam?.abbrev : g.homeTeam?.abbrev;
    if (!oppAbbr) continue;
    const date = (g.gameDate || g.startTimeUTC || "").slice(0, 10);
    const key = `${date}_${oppAbbr}`;
    const isFinal = g.gameState === "OFF" || g.gameState === "FINAL";
    const entry = byKey[key] || {
      id: key, date, opp: oppAbbr, homeAway: isHome ? "home" : "away",
      time: "", tv: "", note: "", projectedGoalie: data.roster.lines.goalies.starter,
    };
    entry.date = date;
    entry.opp = oppAbbr;
    entry.homeAway = isHome ? "home" : "away";
    entry.status = isFinal ? "final" : "scheduled";
    entry.scoreCol = isHome ? g.homeTeam?.score ?? null : g.awayTeam?.score ?? null;
    entry.scoreOpp = isHome ? g.awayTeam?.score ?? null : g.homeTeam?.score ?? null;
    const nets = (g.tvBroadcasts || []).map((b) => b.network).filter(Boolean);
    if (nets.length) entry.tv = [...new Set(nets)].join("/");
    if (g.startTimeUTC) {
      entry.time = new Date(g.startTimeUTC).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      }) + " ET";
    }
    byKey[key] = entry;

    if (isFinal && !data.eloProcessedGameIds.includes(key) && data.opponents[oppAbbr]) {
      const colWon = entry.scoreCol != null && entry.scoreOpp != null && entry.scoreCol > entry.scoreOpp;
      const colElo = data.team_col.elo, oppElo = data.opponents[oppAbbr].elo;
      const homeElo = isHome ? colElo + hfa : oppElo;
      const awayElo = isHome ? oppElo : colElo + hfa;
      const expHome = 1 / (1 + Math.pow(10, -(homeElo - awayElo) / 400));
      const actualHome = isHome ? (colWon ? 1 : 0) : (colWon ? 0 : 1);
      const delta = K * (actualHome - expHome);
      if (isHome) {
        data.team_col.elo = Math.round(colElo + delta);
        data.opponents[oppAbbr].elo = Math.round(oppElo - delta);
      } else {
        data.opponents[oppAbbr].elo = Math.round(oppElo + delta);
        data.team_col.elo = Math.round(colElo - delta);
      }
      data.eloProcessedGameIds.push(key);
      data.stats_current_season.gameLog = data.stats_current_season.gameLog || [];
      data.stats_current_season.gameLog.push({
        gameId: key, date, opp: oppAbbr, colWon, scoreCol: entry.scoreCol, scoreOpp: entry.scoreOpp,
      });
    }
  }
  data.schedule.games = Object.values(byKey).sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const errors = [];

  await refreshStandings(data).catch((e) => errors.push("standings: " + e.message));
  await refreshRoster(data).catch((e) => errors.push("roster: " + e.message));
  await refreshScheduleAndElo(data).catch((e) => errors.push("schedule: " + e.message));

  data.meta.lastRefreshed = new Date().toISOString();
  data.meta.refreshedBy = "Automated hourly job (api-web.nhle.com)";
  data.meta.note = errors.length
    ? "Hourly refresh ran with some errors: " + errors.join("; ") + ". Injuries and news stay hand-maintained."
    : "Schedule, scores, standings-based Elo and roster refresh automatically every hour from the NHL's public API. Injuries and news are hand-maintained in data.json — this job never overwrites them.";

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log("data.json updated at", data.meta.lastRefreshed);
  if (errors.length) console.log("Non-fatal errors:", errors);
}

main().catch((e) => { console.error("Refresh failed:", e); process.exit(1); });
