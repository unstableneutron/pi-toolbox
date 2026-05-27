# pi-native-split

Terminal-native split/window variants of selected Pi session commands.

Currently provides:

- `/split-fork`
- `/split-resume`
- `/split-handoff`
- `/split-tree`

Supported native split backends:

- Ghostty
- Kitty
- Herdr (`HERDR_ENV=1`)

All backends launch Pi through a shared shell wrapper (`launcher.sh`) that:

- opens the target session pre-created by the parent Pi process
- passes startup prompts through a temp file instead of embedding full prompt text in the terminal launch command
- keeps the spawned terminal open on Pi startup failure so errors stay visible and can be retried manually
