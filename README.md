# cache-keeper

A Claude Code mod (function-hook plugin) that keeps an idle session's prompt cache warm. Just before the cache TTL lapses (default: 55 minutes after the last request), it sends a `$.model.fork` ping. The ping is served from the cache and adds nothing to the conversation.

On Opus 5.5, one cache read costs about 1/35–1/40 as much as re-caching the same prefix, measured against subscription usage. Pinging through a workday therefore costs much less than one cold restart.

## Behavior

- Keeps only the main conversation's cache warm. A ping (`$.model.fork`) always replays the main thread's last request, and subagent turns don't arm or reset the timer, so an idle subagent's cache is never pinged and just expires.
- Arms a timer after each main-loop request, so the wait inside a turn counts too: a question (AskUserQuestion) or permission prompt left open while you're away, a plan waiting for approval, a long-running tool. Nothing is pinged while a request is under way.
- Pings at `ttlMinutes − leadMinutes` (60 − 5).
- Waits for the next turn, without pinging, after a `/model` switch or a compaction: the new model or the compacted conversation has nothing cached yet, and a fork then would miss. This holds on Team, Enterprise and managed setups too, through a fallback (see [below](#team-enterprise-and-managed-environments)).
- Retries a ping that fails with an API error once, 2 minutes later (sooner if the cache would lapse first). A second error in a row stops pinging until the next turn. An error is not a miss and benches nothing. A request or turn that an API error ended doesn't count as a refresh, so the next ping stays timed from the last request that reached the cache.
- Stops when:
  - the cache has already expired (e.g. the machine slept);
  - Claude Code reports a 5-minute cache TTL (it says so on a model switch or resume). Pinging every few minutes costs more than a re-cache within the hour. On Team, Enterprise and managed setups the report never reaches the mod (see [below](#team-enterprise-and-managed-environments));
  - you've been idle longer than `maxIdleHours` (8), counted from the last main-loop request (a question left open counts from the request that asked it). The window restarts on any main-loop turn, including ones you didn't type: a background agent's result arriving, a `/loop` wakeup. That's intended, because those turns use the main cache too. `/keepwarm for|until` extends the window to at least that time, and never shortens it;
  - the context is under `minContextTokens` (60k);
  - a ping misses the cache. A miss also benches automatic pings in every session until Claude Code's version changes, because forks can miss the conversation cache (anthropics/claude-code#100083) and a missed ping costs about a full re-cache. A `/keepwarm now` hit lifts the bench.
- Checks itself: the first main-loop request after a pinged break longer than the TTL (a new turn, or a turn going on after you answer a question left open) should read the context from cache. If it reads less than half of it from cache, the pings didn't extend the main cache entry, and automatic pings are benched for that Claude Code version (log `kind: verify`). Later requests don't count, since they write what the turn added. There's no check after a compaction or model switch, since that turn re-writes the context anyway.
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

### Across a restart

The setting (`on`/`off`/`auto` and a `for`/`until` window) is also kept in the plugin's store as `mode/<session id>`, written on each change and deleted when it's back to `auto` with no window. When Claude Code moves the session to a new process (`/bg`, a background session moved by an upgrade, a crash and resume), the new process restores the setting at session start: an off switch stays off and a window still open stays open (one that ended in the meantime is dropped). A hot reload keeps the live setting and ignores the record. Records not written for 30 days, and unreadable ones, are dropped at the next session start. A store failure is ignored; the setting still holds in the running process.

What doesn't survive a restart: the timer and the rest of the keeper's bookkeeping (last request, pings, a pending refresh check). Those described the old process's cache; nothing is pinged in the new process until the next main turn re-arms the keeper. That's a limit of Claude Code, not a choice: `$.model.fork` answers `nothing-to-fork` until a turn has run to its end in the current process, so there's nothing to ping with. A session sent to the background mid-turn is kept warm once that turn ends; one sent while idle stays unwarmed until something starts a turn in it (a message after `claude attach`, a background agent's result, a `/loop` wakeup). The move often costs a re-cache anyway: on 2.1.318 the first request after a move has read only the ~26k-token system prefix about as often as the whole conversation. `/clear` starts a new session id, so the setting doesn't carry across it. Headless sessions are skipped, as always.

## Team, Enterprise and managed environments

Claude Code (2.1.316 and later) ships a built-in plugin, `cc-plugin-sec-default@builtin`. It keeps an organization's classic hooks, prompt content, settings and tool policy out of reach of the plugins a person installs, and adds no policy of its own. `claude plugin list` doesn't show it. Claude Code seats it ahead of every user-installed mod when any of these holds:

- the account is a Team or Enterprise organization;
- the machine has managed settings or a managed MCP file;
- the organization's managed `prependPlugins` lists it.

Once it's seated, it sends these events on past user mods, so their hooks for them never run: every `classic.*` event; `session.compact`; `prompt.section`, `prompt.context`, `prompt.attachment`, `prompt.compose`, `skill.prompt`, `attribution.text` and `settings.read`; and `session.append` rows on the `attachment`, `hook-context` and `compaction` doors (in some cases also `note` rows a managed plugin appends and the `Skill` tool's messages). The `turn.*`, `command.run`, `ui.*` and `session.start`/`session.end` events still reach every mod, as do settings hooks and classic `hooks.json` hooks.

Two of cache-keeper's hooks are skipped:

- `session.compact`, which says a compaction replaced the conversation;
- `classic.PostModelSwitch`, which says the main model changed and reports the cache TTL.

Everything else (the timer, pings, the refresh check, the idle limit, the bench, `/keepwarm` and the setting kept across a restart) runs on events that aren't skipped, and works as described above.

Compactions and model switches are still caught, by a fallback that reads what each leaves behind:

- A compaction clears the live context's token count (`$.session.usage().context.tokens`) until the next response.
- A switch changes the main loop's model (`$.session.model()`). The mod records the model at the start of each main-loop request.

The mod checks both before it decides whether to ping, at the start of each main-loop request, and on `/keepwarm now`. If either shows, it does what the skipped hook would have done: no ping until the next turn, no refresh check on that turn's first request, nothing benched. Where the hooks run, they have already recorded the same thing, so the check changes nothing there. A context with no token count and no messages is `/clear`, not a compaction, and is left to the small-context rule as before. The fallback adds no model calls.

What differs when the plugin is seated:

- **No 5-minute TTL stop.** Claude Code reports the cache TTL only through `classic.PostModelSwitch`, and no event that reaches the mod carries it. If your sessions run on a 5-minute cache, turn keep-warm off (`/keepwarm off`, or the `enabled` option). Otherwise the first ping, sent after the cache has lapsed, misses: it costs about one re-cache and benches pings for that Claude Code version.
- **The status line catches up late.** After a `/compact` or `/model` while you're idle, it keeps showing the old schedule until the ping is due. Then the mod sees the change, sends nothing, and clears the status.
- **A local copy reports each skip.** A mod loaded from a folder (`--plugin-dir`) shows a line when an event goes past it: `its session.compact hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`

To check whether it's seated, start Claude Code with `--debug-file <file>` and look for:

```text
cc-plugin-sec-default@builtin seated outermost: the organization is team
cache-keeper: session.compact bypassed by cc-plugin-sec-default (tier user); beneath runs
cache-keeper: classic.PostModelSwitch bypassed by cc-plugin-sec-default (tier user); beneath runs
```

The first line comes at startup, and its reason depends on why it's seated (this one is from a Team account). The others come when a compaction or model switch happens; plugins skipped together share a line (`cache-keeper+other: …`).

Only managed settings can unseat it, so nobody can turn it off from their own settings. An organization admin can do it for the whole organization with a managed `prependPlugins` (server-managed settings, MDM or `managed-settings.json`) that doesn't list `cc-plugin-sec-default`. That also takes away the protection it gives the organization's own hooks and policy.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-cache-keeper
claude plugin install cache-keeper@cache-keeper --scope user
```

Or from inside Claude Code: `/plugin install cache-keeper --marketplace chrisvaillancourt/claude-cache-keeper`.

On a Team or Enterprise account, or a machine with managed settings, one promise doesn't hold: the mod can't see a 5-minute cache TTL, so it won't stop for one. See [Team, Enterprise and managed environments](#team-enterprise-and-managed-environments).

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
