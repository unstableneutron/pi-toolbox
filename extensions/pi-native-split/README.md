# pi-native-split

Terminal-native split/window variants of selected Pi session commands. Pi 0.84.1
or newer is required.

Currently provides:

- `/split-fork`
- `/split-resume`
- `/split-handoff`
- `/split-tree`

Supported native split backends:

- Ghostty
- Kitty
- Herdr (`HERDR_ENV=1`)

All backends launch Pi through the shared native launcher
(`extensions/shared/native-pi-launcher.sh`, also used by BTW pane mode) that:

- opens the target session pre-created by the parent Pi process
- passes startup prompts through a temp file instead of embedding full prompt text in the terminal launch command
- keeps the spawned terminal open on Pi startup failure so errors stay visible and can be retried manually

`/split-handoff` uses Pi's model registry completion API, so credential-resolved
base URLs, headers, environments, and request transforms apply to its summary
request.
