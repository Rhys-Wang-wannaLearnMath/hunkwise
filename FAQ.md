# FAQ

## Why doesn't a file dragged from Finder always show as "New"?

Older hunkwise builds could miss this case when VSCode opened the file before hunkwise processed the create event.

This is a known timing-dependent behavior. There is no reliable VSCode API to distinguish "user created a new file in the editor" from "user dragged an external file into the explorer" — `onWillCreateFiles` fires for both.

Current builds treat new file creates as reviewable changes even when VSCode opens the file immediately.

## Does hunkwise require VS Code proposed APIs?

No. Current builds use VS Code's native inline diff editor plus CodeLens for hunk navigation and Accept/Discard actions.

Older builds used the proposed `editorInsets` API for visual deleted-line blocks. That path has been removed to reduce rendering instability and avoid proposed-API compatibility issues on stable VS Code.
