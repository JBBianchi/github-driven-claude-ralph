# Task: Add process-tree visibility to Claude heartbeats

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-03-03T16:20:02.0000000+01:00
- **Completed:** 2026-03-03T16:20:43.4176107+01:00

## Objective

Expose currently running descendant commands for long Claude invocations so stuck states can be diagnosed from logs.

## Work performed

- Confirmed heartbeats can remain at zero output bytes for long periods, leaving runtime activity ambiguous.
- Added Linux /proc parsing in src/claude.ts to capture descendant process snapshots.
- Included processSnapshot in Claude heartbeat logger context.
- Included processSnapshot=... in claude.log heartbeat lines.
- Kept existing heartbeat cadence and timeout behavior unchanged.

## Decisions made

- Kept implementation Linux-focused because runtime environment is Docker Linux.
- Gracefully degrade to 
ull snapshot when /proc is unavailable.

## Blockers / uncertainties

- None.

## Outcome

Completed. Heartbeat logs now expose the active child-command chain under Claude, making long "silent" runs diagnosable.
