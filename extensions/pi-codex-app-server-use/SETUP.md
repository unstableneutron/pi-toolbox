# Computer Use setup

This extension only forwards Pi tools to the running Codex AppServer. It does
not install Codex plugins or change macOS permissions by itself.

Prefer this as a checklist over an ad hoc installer script: Computer Use setup
touches macOS Accessibility, Screen Recording, and optionally the macOS unlock
authorization database.

## What to install

There are two separate pieces:

1. **Codex Computer Use plugin** — the normal Codex plugin that exposes the
   `computer-use` MCP server.
2. **Locked Computer Use authorization plug-in** — a macOS SecurityAgent
   plug-in that lets Codex temporarily unlock a locked Mac during an active,
   trusted Computer Use turn.

## Install or enable the Codex plugin

Use the Codex app first:

```text
Codex Settings → Computer Use → Install
```

Then enable the Pi extension surface where needed:

```text
/codex-app-server computer-use enabled project
/codex-app-server-doctor
```

The Codex plugin should appear in `~/.codex/config.toml`:

```toml
[plugins."computer-use@openai-bundled"]
enabled = true
```

On macOS, grant both permissions when prompted:

- Screen Recording
- Accessibility

## Install locked Computer Use

Use the Codex settings UI first when available:

```text
Codex Settings → Computer Use → Enable locked computer use
```

If the UI is unavailable, the bundled installer can be invoked manually:

```bash
RES="$HOME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources"
TOOL="$RES/CodexComputerUseAuthorizationPluginInstallerTool"

sudo "$TOOL" install "$RES"
"$TOOL" status "$RES"
```

Expected status:

```text
OK: installed
```

Verify the macOS authorization database:

```bash
security authorizationdb read com.openai.sky.CUAService.AuthorizationPlugin.remote
security authorizationdb read system.login.screensaver
```

`system.login.screensaver` should include both entries:

```text
com.openai.sky.CUAService.AuthorizationPlugin.remote
use-login-window-ui
```

## Uninstall locked Computer Use

This restores stock screen-unlock behavior:

```bash
RES="$HOME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources"
TOOL="$RES/CodexComputerUseAuthorizationPluginInstallerTool"

sudo "$TOOL" uninstall "$RES"
"$TOOL" status "$RES"
```

Expected status after uninstall:

```text
OK: not-installed
```

## Use Computer Use while locked

Locked use is intentionally narrow. It is not a general-purpose remote unlock
mechanism.

Checklist:

1. Codex Computer Use plugin is installed and enabled.
2. macOS Screen Recording and Accessibility are granted.
3. Locked Computer Use authorization plug-in reports `OK: installed`.
4. The target app is on the Computer Use approved-app list.
5. Start an active Computer Use turn from Codex or a connected device, then let
   the Mac lock.

During an active trusted turn, Codex can temporarily unlock the Mac, cover the
display, operate the allowed app, and relock if local keyboard or pointer input
is detected.

## Approved application allow list

Computer Use stores persistent app approvals here:

```text
~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json
```

The safer path is to let Codex request an app once and choose **Always allow**.
For managed setup, edit the JSON list of bundle identifiers.

### Print approvals

```bash
APPROVALS="$HOME/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json"
export APPROVALS

python3 - <<'PY'
import json, os, pathlib

p = pathlib.Path(os.environ["APPROVALS"])
data = json.loads(p.read_text())
for bundle_id in sorted(data.get("approvedBundleIdentifiers", [])):
    print(bundle_id)
PY
```

### Add apps

Use bundle identifiers, not app names. Examples:

```text
com.google.Chrome
org.mozilla.firefox
com.brave.Browser
com.apple.Safari
com.microsoft.VSCode
pl.maketheweb.cleanshotx
com.paloaltonetworks.GlobalProtect.client
com.if.Amphetamine
biz.airbnb.handshake
```

Add one or more bundle IDs:

```bash
APPROVALS="$HOME/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json"
export APPROVALS

python3 - com.microsoft.VSCode pl.maketheweb.cleanshotx <<'PY'
import json, os, pathlib, sys

p = pathlib.Path(os.environ["APPROVALS"])
data = json.loads(p.read_text()) if p.exists() else {}
ids = set(data.get("approvedBundleIdentifiers", []))
ids.update(sys.argv[1:])
data["approvedBundleIdentifiers"] = sorted(ids)
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(data, separators=(",", ":")))
print(f"wrote {len(ids)} approved bundle IDs")
PY
```

### Remove apps

Remove one or more bundle IDs:

```bash
APPROVALS="$HOME/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json"
export APPROVALS

python3 - com.microsoft.VSCode <<'PY'
import json, os, pathlib, sys

p = pathlib.Path(os.environ["APPROVALS"])
data = json.loads(p.read_text())
remove = set(sys.argv[1:])
ids = [x for x in data.get("approvedBundleIdentifiers", []) if x not in remove]
data["approvedBundleIdentifiers"] = sorted(ids)
p.write_text(json.dumps(data, separators=(",", ":")))
print(f"wrote {len(ids)} approved bundle IDs")
PY
```

Terminal emulators such as Kitty (`net.kovidgoyal.kitty`) are higher risk than
browsers or status-bar utilities because Computer Use can type shell commands
into them. Prefer adding terminals only for a specific trusted workflow.
