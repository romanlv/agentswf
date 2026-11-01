---
name: changelog
description: Writes a changelog entry for a branch's changes, in the project's changelog style. Use when asked for a changelog entry or release notes.
---

# Changelog

1. Read `git log origin/main..HEAD` and the diff.
2. Write one entry per change a user would notice, in the past tense, each under Added, Changed
   or Fixed.
3. Leave out refactors, tests and anything else a user wouldn't see.
