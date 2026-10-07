# cache-keeper

A Claude Code mod (function-hook plugin) that keeps an idle session's prompt cache warm. Just before the cache TTL lapses (default: 55 minutes after the last request), it sends a `$.model.fork` ping. The ping is served from the cache and adds nothing to the conversation.

On Opus 5.5, one cache read costs about 1/35–1/40 as much as re-caching the same prefix, measured against subscription usage. Pinging through a workday therefore costs much less than one cold restart.

## Behavior

- Arms a timer after each main-loop turn; subagent turns are ignored.
- Pings at `ttlMinutes − leadMinutes` (60 − 5).
- Stops when:
  - the cache has already expired (e.g. the machine slept);
  - you've been idle longer than `maxIdleHours` (8), unless `/keepwarm for|until` set a window;
  - the context is under `minContextTokens` (60k);
  - five-hour or weekly usage is at or above `maxLimitPercent` (85);
  - a ping misses the cache. A miss also benches automatic pings in every session until Claude Code's version changes, because forks can miss the conversation cache (anthropics/claude-code#100083) and a missed ping costs about a full re-cache. A `/keepwarm now` hit lifts the bench.
- Skips headless sessions (`-p`, SDK).
- Logs every ping to `~/.claude/cache-keeper/<session-id>.jsonl`: token usage, plan-usage percentage before and after, and API-equivalent cost before and after.

## Command

`/keepwarm [status | on | off | auto | now | for 3h | until 18:00]`

## Install (local folder marketplace)

```sh
claude plugin marketplace add ~/dev/github/chrisvaillancourt/claude-cache-keeper
claude plugin install cache-keeper@cache-keeper --scope user
```

The plugin is read from this folder. After editing, run `/reload-plugins`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```
