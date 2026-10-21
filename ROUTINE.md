# Routine instructions

The daily routine's saved prompt only points here. Follow these steps
exactly, in order, and run no other command.

1. Run `node src/routine.js`. Run `node src/routine.js --probe` instead only
   when the prompt says to probe.
2. Report the final `RESULT` line, or the error output if the script failed.
   Do not run git, collection or the build yourself.

`RESULT unchanged` means nothing under `data/` or `docs/` differed and nothing
was committed. `RESULT committed <sha>` means the commit is already pushed to
`master`; that is the only branch this routine uses. `RESULT probe <sha>` means
the probe commit is pushed to `master` and the API and healthcheck hosts
answered. If a hook reports unpushed commits on the session's `claude/…`
branch or asks you to push it, do not push it and do not open a pull request:
say that the commit is on `master` and stop.
