# cache-keeper

A Claude Code mod (function-hook plugin) that keeps an idle session's prompt cache warm. Just before the cache TTL lapses (default: 55 minutes after the last request), it sends a `$.model.fork` ping. The ping is served from the cache and adds nothing to the conversation.

On Opus 5.5, one cache read costs about 1/35–1/40 as much as re-caching the same prefix, measured against subscription usage. Pinging through a workday therefore costs much less than one cold restart.

## Behavior

- Keeps only the main conversation's cache warm. A ping (`$.model.fork`) always replays the main thread's last request, and subagent turns don't arm or reset the timer, so an idle subagent's cache is never pinged and just expires.
- Arms a timer after each main-loop turn.
- Pings at `ttlMinutes − leadMinutes` (60 − 5).
- Waits for the next turn, without pinging, after a `/model` switch or a compaction: the new model or the compacted conversation has nothing cached yet, and a fork then would miss.
- Retries a ping that fails with an API error once, 2 minutes later (sooner if the cache would lapse first). A second error in a row stops pinging until the next turn. An error is not a miss and benches nothing.
- Stops when:
  - the cache has already expired (e.g. the machine slept);
  - Claude Code reports a 5-minute cache TTL (it says so on a model switch or resume). Pinging every few minutes costs more than a re-cache within the hour;
  - you've been idle longer than `maxIdleHours` (8). The window restarts on any main-loop turn, including ones you didn't type: a background agent's result arriving, a `/loop` wakeup. That's intended, because those turns use the main cache too. `/keepwarm for|until` extends the window to at least that time, and never shortens it;
  - the context is under `minContextTokens` (60k);
  - a ping misses the cache. A miss also benches automatic pings in every session until Claude Code's version changes, because forks can miss the conversation cache (anthropics/claude-code#100083) and a missed ping costs about a full re-cache. A `/keepwarm now` hit lifts the bench.
- Checks itself: the first request of the first real turn after a pinged break longer than the TTL should read the context from cache. If it re-writes most of it, the pings didn't extend the main cache entry, and automatic pings are benched for that Claude Code version (log `kind: verify`). Later requests in that turn don't count, since they write what the turn added. There's no check after a compaction or model switch, since that turn re-writes the context anyway.
- Keeps pinging whatever your plan usage. Past the plan's limit, extra usage bills per token, and a ping (a cache read, about 0.1× the input price) costs about a twentieth of the re-cache it saves (a 1-hour cache write, about 2×). If you're blocked at the limit instead, the ping fails with an API error and pinging stops until the next turn, with no bench.
- Skips headless sessions (`-p`, SDK).
- Logs to `~/.claude/cache-keeper/<session-id>.jsonl`:
  - every ping: token usage, plan-usage percentage before and after, and API-equivalent cost before and after;
  - every stop: the reason, context size, plan usage, model and Claude Code version. `off` is logged once per switch to off, not after every turn.

## Command

`/keepwarm [status | on | off | auto | now | for 3h | until 18:00]`

- `on` / `off` / `auto`: keep warm always, never, or as the `enabled` option says. Each clears a `for`/`until` window.
- `for 3h` / `until 18:00`: keep warm at least that long, even when the mode is off. When the window ends, the mode and idle limit apply again.
- `now`: ping right away and report what the cache served. It won't ping after a model switch or compaction, when nothing is cached yet.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-cache-keeper
claude plugin install cache-keeper@cache-keeper --scope user
```

Or from inside Claude Code: `/plugin install cache-keeper --marketplace chrisvaillancourt/claude-cache-keeper`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin update cache-keeper@cache-keeper
```

Then restart Claude Code. If it says the plugin is already at the latest version but a newer release exists, refresh the marketplace first and run the update again:

```sh
claude plugin marketplace update cache-keeper
claude plugin update cache-keeper@cache-keeper
```

## Develop

```sh
claude plugin validate .
claude plugin test .
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...).

## License

MIT. See [LICENSE](LICENSE).
