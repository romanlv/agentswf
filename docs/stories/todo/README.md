---
title: Todo
type: guide
status: active
---

# Todo

This directory is the inbox for possible stories discovered while refining or implementing another
story. Todo items are not approved scope and are not ready for implementation.

Use a descriptive filename; numbering is assigned only when an item is promoted to a refined story.
A todo needs only:

```md
---
title: <Short title>
summary: <One sentence describing the work>
type: story
status: todo
discovered_in: <story id, code path, test, or investigation>
depends_on: []
---

# <Short title>

Why it matters: <failure, opportunity, or unresolved constraint>

Notes: <known evidence, likely area, and dependencies>
```

Prefer one concrete concern per file. Link the new todo from the originating story's implementation
notes, then continue the original scope.
