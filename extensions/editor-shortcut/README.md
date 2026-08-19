# pi-editor-shortcut

`pi-editor-shortcut` adds inline editor directives for selecting models and
thinking levels, controlling supported OpenAI priority mode, and inserting
clipboard text into prompt context.

## Directives

Use directives alone or inline with a prompt:

```text
$model:openai/gpt-5.5
$thinking:high
$fast:on
Implement the change.
```

Available directives:

- `$model:<provider>/<model>` selects a configured model.
- `$thinking:<level>` sets the thinking level.
- `$fast[:on|off]` controls priority mode for supported OpenAI models.
- `$paste[:tag]` inserts clipboard text as a tagged context block.
- `$paste:auto` generates a short tag when a configured review model exists.

The extension also adds `/fast [on|off]` and autocomplete for these shortcuts.

## Prime Agent

Prime Agent uses the same public editor, autocomplete, input, model, and
provider-request APIs. Install the wrapper package:

```bash
prime-agent package install /absolute/path/to/extensions/editor-shortcut/prime-package
```

Test it for one run:

```bash
prime-agent --offline --no-session --no-skills --no-prompt-templates \
  --no-context-files --no-builtin-tools \
  -e /absolute/path/to/extensions/editor-shortcut/prime-package --mode json -p '$thinking:low'
```

`$fast` remains intentionally limited to the existing supported model list.

## Development

From `extensions/editor-shortcut/`:

```bash
aube run check --no-install
aube run test --no-install
```
