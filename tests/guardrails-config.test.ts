import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

interface PatternConfig {
  pattern: string;
  regex?: boolean;
}

interface GuardrailsConfig {
  permissionGate?: {
    allowedPatterns?: PatternConfig[];
  };
}

function loadGuardrailsConfig(): GuardrailsConfig {
  const source = readFileSync(
    new URL('../extensions-config/guardrails.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(source) as GuardrailsConfig;
}

function compileAllowedPatterns(): RegExp[] {
  return (loadGuardrailsConfig().permissionGate?.allowedPatterns ?? []).map((entry) => {
    if (!entry.regex) {
      throw new Error(`Expected regex allowedPattern, got literal: ${entry.pattern}`);
    }
    return new RegExp(entry.pattern);
  });
}

function matchesAllowed(command: string): boolean {
  return compileAllowedPatterns().some((pattern) => pattern.test(command));
}

const releaseScript = String.raw`set -euo pipefail
cd /Users/exampleuser/Projects/zmosh/.worktrees/nat-traversal-and-recovery
pkill -f 'zmosh attach -r vn3 nat-validate-1775502174' || true
rm -rf /tmp/zmosh-prerelease-b4ff105
mkdir -p /tmp/zmosh-prerelease-b4ff105
gh release download nat-traversal-and-recovery -R unstableneutron/zmosh \
  -p 'zmosh-0.5.2-macos-aarch64.tar.gz' \
  -p 'zmosh-0.5.2-linux-x86_64.tar.gz' \
  -D /tmp/zmosh-prerelease-b4ff105
rm -rf /tmp/zmosh-prerelease-b4ff105/macos /tmp/zmosh-prerelease-b4ff105/linux
mkdir -p /tmp/zmosh-prerelease-b4ff105/macos /tmp/zmosh-prerelease-b4ff105/linux

tar -xzf /tmp/zmosh-prerelease-b4ff105/zmosh-0.5.2-macos-aarch64.tar.gz -C /tmp/zmosh-prerelease-b4ff105/macos
install /tmp/zmosh-prerelease-b4ff105/macos/zmosh ~/.local/bin/zmosh

tar -xzf /tmp/zmosh-prerelease-b4ff105/zmosh-0.5.2-linux-x86_64.tar.gz -C /tmp/zmosh-prerelease-b4ff105/linux
scp /tmp/zmosh-prerelease-b4ff105/zmosh-0.5.2-linux-x86_64.tar.gz vn3:/tmp/zmosh-0.5.2-linux-x86_64.tar.gz
ssh vn3 'set -euo pipefail; rm -rf /tmp/zmosh-install && mkdir -p /tmp/zmosh-install && tar -xzf /tmp/zmosh-0.5.2-linux-x86_64.tar.gz -C /tmp/zmosh-install && mkdir -p ~/.local/bin && install /tmp/zmosh-install/zmosh ~/.local/bin/zmosh'

echo 'LOCAL VERSION:'
~/.local/bin/zmosh version
echo 'REMOTE VERSION:'
ssh vn3 '~/.local/bin/zmosh version'`;

describe('guardrails allowPatterns config hygiene', () => {
  test('keeps the temp-cleanup allowlist intentionally small and regex-only', () => {
    const entries = loadGuardrailsConfig().permissionGate?.allowedPatterns ?? [];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(8);
    expect(entries.every((entry) => entry.regex === true)).toBe(true);
  });
});

describe('guardrails temp-root allowlist', () => {
  test('allows only the exact dist cleanup forms that were intentionally whitelisted', () => {
    expect(matchesAllowed('rm -rf dist')).toBe(true);
    expect(matchesAllowed('rm -rf dist/')).toBe(true);
    expect(matchesAllowed('rm -rf ./dist')).toBe(false);
    expect(matchesAllowed('rm -rf dist build')).toBe(false);
  });

  test('allows the exact /tmp delete shape', () => {
    expect(matchesAllowed('rm -rf /tmp/jjtest')).toBe(true);
  });

  test('allows the multiline release script with only temp-root recursive deletes', () => {
    expect(matchesAllowed(releaseScript)).toBe(true);
  });

  test('allows inline remote shell cleanup under /tmp', () => {
    expect(matchesAllowed("ssh host 'rm -rf /tmp/x && mkdir -p /tmp/x'")).toBe(true);
  });

  test('allows multiple temp-root targets in one rm invocation', () => {
    expect(matchesAllowed('rm -rf /tmp/a /tmp/b/c')).toBe(true);
  });

  test('allows quoted /private/tmp deletes with combined short flags', () => {
    expect(matchesAllowed('rm -fr "/private/tmp/foo-bar" && mkdir -p "/private/tmp/foo-bar"')).toBe(
      true,
    );
    expect(matchesAllowed('rm -rvf "/private/tmp/foo-bar"')).toBe(true);
  });

  test('rejects traversal paths that escape /tmp', () => {
    expect(matchesAllowed('rm -rf /tmp/../Users/exampleuser')).toBe(false);
    expect(matchesAllowed('rm -rf /private/tmp/../../etc')).toBe(false);
  });

  test('rejects mixed safe and unsafe recursive deletes', () => {
    expect(matchesAllowed('rm -rf /tmp/a /Users/exampleuser/project')).toBe(false);
    expect(matchesAllowed('rm -rf /tmp/a ~/other')).toBe(false);
    expect(matchesAllowed('rm -rf /tmp/safe && rm -rf ~')).toBe(false);
    expect(matchesAllowed('rm -rf ~; rm -rf /tmp/safe')).toBe(false);
    expect(matchesAllowed('rm -rf /tmp/safe && sh -c "rm -rf ~"')).toBe(false);
    expect(matchesAllowed("ssh host 'rm -rf /Users/exampleuser/project'")).toBe(false);
  });

  test('rejects other dangerous commands even when a safe temp delete is present', () => {
    expect(matchesAllowed('rm -rf /tmp/a && terraform destroy')).toBe(false);
    expect(matchesAllowed('rm -rf /tmp/a && git push --force')).toBe(false);
    expect(matchesAllowed('rm -rf /tmp/a && kubectl delete pod demo')).toBe(false);
    expect(matchesAllowed('sudo rm -rf /tmp/a')).toBe(false);
  });

  test('rejects inert-text and heredoc bypass attempts conservatively', () => {
    expect(matchesAllowed("echo 'rm -rf /tmp/safe'\nrm -rf /Users/exampleuser/project")).toBe(
      false,
    );
    expect(matchesAllowed('# rm -rf /tmp/safe\nrm -rf /Users/exampleuser/project')).toBe(false);
    expect(
      matchesAllowed("cat <<'EOF'\nrm -rf /tmp/safe\nEOF\nrm -rf /Users/exampleuser/project"),
    ).toBe(false);
  });

  test('rejects bare temp roots, prefix tricks, globs, and expansions', () => {
    expect(matchesAllowed('rm -rf /tmp')).toBe(false);
    expect(matchesAllowed('rm -rf /private/tmp')).toBe(false);
    expect(matchesAllowed('rm -rf /tmpfoo')).toBe(false);
    expect(matchesAllowed('rm -rf /tmp/*')).toBe(false);
    expect(matchesAllowed('rm -rf "/tmp/$NAME"')).toBe(false);
  });

  test('rejects non-temp deletes that should still prompt', () => {
    expect(matchesAllowed('rm -rf extensions/model-request-info')).toBe(false);
    expect(matchesAllowed('rm -rf ~/.pi/agent/extensions/pi-mcp-adapter')).toBe(false);
  });
});

describe('guardrails mktemp motivating-example allowlist', () => {
  const motivatingExample = `set -euo pipefail
root=$(mktemp -d)
mkdir -p "$root/home/project/node_modules/.gitchamber/repo" "$root/home/project/node_modules/pkg"
: > "$root/home/project/node_modules/.gitchamber/repo/file.txt"
: > "$root/home/project/node_modules/pkg/file.txt"
cat > "$root/home/project/.gitignore" <<'EOF'
node_modules/
EOF
cat > "$root/home/.config_git_ignore" <<'EOF'
!**/node_modules/.gitchamber/
!**/node_modules/.gitchamber/**
EOF
cd "$root/home/project"
echo 'rg with project .gitignore + external global-like ignore-file:'
rg --files . --ignore-file "$root/home/.config_git_ignore" | sort
rm -rf "$root"`;

  test('allows only the exact motivating mktemp cleanup template', () => {
    expect(matchesAllowed(motivatingExample)).toBe(true);
  });

  test('rejects the motivating example when the leading strict shell line is removed', () => {
    expect(matchesAllowed(motivatingExample.replace('set -euo pipefail\n', ''))).toBe(false);
  });

  test('rejects mktemp scripts that reassign the temp variable before delete', () => {
    expect(
      matchesAllowed(`root=$(mktemp -d)
root=/
rm -rf "$root"`),
    ).toBe(false);
  });

  test('rejects mktemp scripts with writes outside the temp root', () => {
    expect(
      matchesAllowed(`root=$(mktemp -d)
printf 'x' > /tmp/not-rooted
rm -rf "$root"`),
    ).toBe(false);
  });

  test('rejects command substitution and backtick injection inside otherwise safe-looking lines', () => {
    expect(
      matchesAllowed(`set -euo pipefail
root=$(mktemp -d)
mkdir -p "$root/home/project/node_modules/.gitchamber/repo" "$root/home/project/node_modules/pkg"
: > "$root/home/project/node_modules/.gitchamber/repo/file.txt"
: > "$root/home/project/node_modules/pkg/file.txt"
cat > "$root/home/project/.gitignore" <<'EOF'
node_modules/
EOF
cat > "$root/home/.config_git_ignore" <<'EOF'
!**/node_modules/.gitchamber/
!**/node_modules/.gitchamber/**
EOF
cd "$root/home/project"
echo $(terraform destroy)
rg --files . --ignore-file "$root/home/.config_git_ignore" | sort
rm -rf "$root"`),
    ).toBe(false);

    expect(
      matchesAllowed(`set -euo pipefail
root=$(mktemp -d)
mkdir -p "$root/home/project/node_modules/.gitchamber/repo" "$root/home/project/node_modules/pkg"
: > "$root/home/project/node_modules/.gitchamber/repo/file.txt"
: > "$root/home/project/node_modules/pkg/file.txt"
cat > "$root/home/project/.gitignore" <<'EOF'
node_modules/
EOF
cat > "$root/home/.config_git_ignore" <<'EOF'
!**/node_modules/.gitchamber/
!**/node_modules/.gitchamber/**
EOF
cd "$root/home/project"
echo \`terraform destroy\`
rg --files . --ignore-file "$root/home/.config_git_ignore" | sort
rm -rf "$root"`),
    ).toBe(false);
  });

  test('rejects piggybacked dangerous commands and executable find-style flags', () => {
    expect(
      matchesAllowed(`root=$(mktemp -d)
terraform destroy
rm -rf "$root"`),
    ).toBe(false);
    expect(
      matchesAllowed(`root=$(mktemp -d)
find . -exec rm -rf / ;
rm -rf "$root"`),
    ).toBe(false);
    expect(
      matchesAllowed(`root=$(mktemp -d)
rm -rf /tmp/other
rm -rf "$root"`),
    ).toBe(false);
  });
});
