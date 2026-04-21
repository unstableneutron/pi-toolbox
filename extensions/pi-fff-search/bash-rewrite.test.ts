import { describe, expect, test } from 'vitest';
import { tryRewriteBash } from './bash-rewrite';

const CWD = '/repo';

function rewrite(cmd: string) {
  return tryRewriteBash(cmd, CWD);
}

describe('tryRewriteBash — single-command rewrites', () => {
  test('cat FILE → read', () => {
    const r = rewrite('cat src/router.ts');
    expect(r?.decision).toMatchObject({ tool: 'read', params: { path: 'src/router.ts' } });
  });

  test('cat FILE with leading cd → read', () => {
    const r = rewrite('cd /tmp && cat node_modules/impers/dist/public.d.ts');
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'node_modules/impers/dist/public.d.ts' },
      recognizer: 'cat-file',
    });
  });

  test('cat MULTIPLE FILES → pass through', () => {
    expect(rewrite('cat file1.ts file2.ts')).toBeNull();
  });

  test('cat with flag → pass through', () => {
    expect(rewrite('cat -n file.ts')).toBeNull();
  });

  test('ls DIR → builtin ls', () => {
    const r = rewrite('ls src/');
    expect(r?.decision).toMatchObject({ tool: 'ls', params: { path: 'src/' } });
  });

  test('ls with no target → builtin ls with defaults', () => {
    const r = rewrite('ls');
    expect(r?.decision).toMatchObject({ tool: 'ls', params: {} });
  });

  test('ls -la DIR → drop flag and use builtin ls', () => {
    const r = rewrite('ls -la ~/.pi/agent/');
    expect(r?.decision).toMatchObject({ tool: 'ls', params: { path: '~/.pi/agent/' } });
  });

  test('ls --unknown-long-flag → pass through', () => {
    expect(rewrite('ls --recursive foo')).toBeNull();
  });

  test('head -N FILE → read with limit', () => {
    const r = rewrite('head -80 /tmp/a.ts');
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: '/tmp/a.ts', limit: 80 },
    });
  });

  test('head -n N FILE → read with limit', () => {
    const r = rewrite('head -n 40 /tmp/a.ts');
    expect(r?.decision).toMatchObject({ tool: 'read', params: { limit: 40 } });
  });

  test('head --lines=N FILE → read with limit', () => {
    const r = rewrite('head --lines=25 a.ts');
    expect(r?.decision).toMatchObject({ tool: 'read', params: { limit: 25 } });
  });

  test('head -c 100 FILE → pass through (byte limit has no clean read mapping)', () => {
    expect(rewrite('head -c 100 a.ts')).toBeNull();
  });

  test('head with no file arg → pass through', () => {
    expect(rewrite('head -20')).toBeNull();
  });
});

describe('tryRewriteBash — grep rewrites', () => {
  test('plain grep PAT FILE → fff_grep literal: false', () => {
    const r = rewrite('grep foo src/router.ts');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['foo'], within: 'src/router.ts', literal: false },
    });
  });

  test('grep -n PAT PATH → ignored flag (fff already returns line numbers)', () => {
    const r = rewrite('grep -n "createLsToolDefinition" file.ts');
    expect(r?.decision.params).toEqual({
      patterns: ['createLsToolDefinition'],
      within: 'file.ts',
      literal: false,
    });
  });

  test('grep -rn PAT PATH → bundled short flags', () => {
    const r = rewrite('grep -rn "pi-update" mise.toml');
    expect(r?.decision).toMatchObject({ tool: 'fff_grep' });
  });

  test('grep -i case-insensitive', () => {
    const r = rewrite('grep -i hello file.ts');
    expect(r?.decision.params).toMatchObject({ case_sensitive: false });
  });

  test('grep -F literal', () => {
    const r = rewrite('grep -F "foo(bar)" file.ts');
    expect(r?.decision.params).toMatchObject({ literal: true });
  });

  test('egrep treated as -E regex', () => {
    const r = rewrite('egrep "foo|bar" f.ts');
    expect(r?.decision.params).toMatchObject({ literal: false });
  });

  test('grep -A 5 context', () => {
    const r = rewrite('grep -A 5 foo file.ts');
    expect(r?.decision.params).toMatchObject({ context_lines: 5 });
  });

  test('grep -A5 bundled context', () => {
    const r = rewrite('grep -A5 foo file.ts');
    expect(r?.decision.params).toMatchObject({ context_lines: 5 });
  });

  test('grep --include=*.ts', () => {
    const r = rewrite('grep --include="*.ts" pattern src/');
    expect(r?.decision.params).toMatchObject({ glob: '*.ts' });
  });

  test('grep --exclude-dir=node_modules', () => {
    const r = rewrite('grep --exclude-dir=node_modules foo src/');
    expect(r?.decision.params).toMatchObject({ exclude_paths: ['node_modules'] });
  });

  test('grep -v invert → pass through', () => {
    expect(rewrite('grep -v foo file.ts')).toBeNull();
  });

  test('grep -l files-with-matches → pass through', () => {
    expect(rewrite('grep -l "foo" file.ts')).toBeNull();
  });

  test('grep with multiple paths → pass through', () => {
    expect(rewrite('grep foo a.ts b.ts c.ts')).toBeNull();
  });

  test('grep -- PAT FILE with end-of-opts marker', () => {
    const r = rewrite('grep -- -x file.ts');
    expect(r?.decision.params).toMatchObject({ patterns: ['-x'], literal: false });
  });
});

describe('tryRewriteBash — find rewrites', () => {
  test('find PATH -name GLOB → fff_find_files', () => {
    const r = rewrite('find src/ -name "*.router.ts"');
    expect(r?.decision).toMatchObject({
      tool: 'fff_find_files',
      params: { within: 'src/', glob: '*.router.ts' },
    });
  });

  test('find PATH -type f -name → fff_find_files', () => {
    const r = rewrite('find src/ -type f -name "router.ts"');
    expect(r?.decision?.tool).toBe('fff_find_files');
  });

  test('find with -type d → pass through (fff is file-oriented)', () => {
    expect(rewrite('find . -type d -name "node_modules"')).toBeNull();
  });

  test('find with -exec → pass through', () => {
    expect(rewrite('find . -name "*.ts" -exec rm {} \\;')).toBeNull();
  });

  test('find with -mtime → pass through', () => {
    expect(rewrite('find ~/.pi/agent/sessions -name "*.jsonl" -mtime -2')).toBeNull();
  });

  test('find with -o (OR) → pass through', () => {
    expect(rewrite('find ~/.pi ~/.config -name "models.json" -o -name "config.json"')).toBeNull();
  });

  test('find with generic glob only (no derivable query) → pass through', () => {
    expect(rewrite('find . -name "*.ts"')).toBeNull();
  });

  test('fd pattern → fff_find_files', () => {
    const r = rewrite('fd router src/');
    expect(r?.decision).toMatchObject({
      tool: 'fff_find_files',
      params: { query: 'router', within: 'src/' },
    });
  });
});

describe('tryRewriteBash — pipelines', () => {
  test('grep | head -N → fff_grep with limit', () => {
    const r = rewrite('grep -rn "foo" src/ | head -20');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['foo'], within: 'src/', limit: 20 },
      recognizer: 'grep-search+head',
    });
  });

  test('cat | head -N → read with limit', () => {
    const r = rewrite('cat /tmp/a.ts | head -80');
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: '/tmp/a.ts', limit: 80 },
    });
  });

  test('ls | head -N → ls with limit', () => {
    const r = rewrite('ls -la ~/.pi/ | head -40');
    expect(r?.decision).toMatchObject({ tool: 'ls', params: { limit: 40 } });
  });

  test('find | head -N → fff_find_files with limit', () => {
    const r = rewrite('find src/ -name "*router*" | head -5');
    expect(r?.decision).toMatchObject({
      tool: 'fff_find_files',
      params: { limit: 5 },
      recognizer: 'find-name-glob+head',
    });
  });

  test('find <path> -type f | head -1 | xargs cat → read', () => {
    const r = rewrite('find /a/b.ts -type f | head -1 | xargs cat');
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: '/a/b.ts' },
      recognizer: 'find-xargs-cat',
    });
  });

  test('find <path> -type f | head -1 | xargs cat | head -80 → read with limit', () => {
    const r = rewrite('find /a/b.ts -type f | head -1 | xargs cat | head -80');
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: '/a/b.ts', limit: 80 },
    });
  });

  test('find <path> -type f | head -1 | xargs cat with trailing 2>/dev/null | head -80', () => {
    const r = rewrite(
      'find extensions/foo.d.ts -type f | head -1 | xargs cat 2>/dev/null | head -80',
    );
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'extensions/foo.d.ts', limit: 80 },
    });
  });

  test('grep | sort | head → pass through (sort breaks the pattern)', () => {
    expect(rewrite('grep foo f.ts | sort | head -10')).toBeNull();
  });

  test('grep | grep | head → pass through (filter chain)', () => {
    expect(rewrite('grep foo f.ts | grep bar | head -10')).toBeNull();
  });

  test('grep | sed → pass through', () => {
    expect(rewrite('grep foo f.ts | sed "s/a/b/"')).toBeNull();
  });
});

describe('tryRewriteBash — explicit non-rewrites (real traffic patterns)', () => {
  const PASS_THROUGH = [
    // Build/test output trimming — these are NOT searches.
    'pnpm test 2>&1 | tail -20',
    'pnpm install --silent 2>&1 | tail -5',
    'pnpm run check:lint 2>&1 | tail -10',
    'bun pm trust impers 2>&1 | tail -20',
    'bun install 2>&1 | tail -15',
    'npx vitest run 2>&1 | tail -25',
    'chezmoi diff ~/.pi/agent/settings.json 2>&1 | head -60',
    "airbnb-sourcegraph-cli search 'file:tools-loop/apps/gandalf' 2>&1 | head -40",
    'mise run pi-update 2>&1 | tail -60',
    // Multi-step setup/cleanup chains.
    'cd /tmp && rm -rf impers-check && mkdir impers-check && cd impers-check && bun init -y',
    'cd /Users/x/repo && bun --version && node --version 2>/dev/null || true',
    'mkdir -p /tmp/foo && cat /tmp/foo/a',
    // Subshells and command substitution.
    'cat $(ls) | head',
    'echo "$(date)" > log',
    'grep foo `which ls`',
    // Redirects we cannot safely drop.
    'grep foo file > results.txt',
    'cat file >> log',
    'grep foo < input',
    // Git/jj/version-control commands.
    'git status',
    'git diff --stat',
    'jj status',
    // Heredocs and script bodies.
    "python3 -c 'import json\\nprint(json.dumps({}))'",
    "bash -c 'for s in a b c; do echo $s; done'",
  ];

  for (const cmd of PASS_THROUGH) {
    test(`pass-through: ${JSON.stringify(cmd)}`, () => {
      expect(rewrite(cmd)).toBeNull();
    });
  }
});

describe('tryRewriteBash — trivial-redirect stripping', () => {
  test('strips trailing 2>/dev/null', () => {
    const r = rewrite('grep foo file.ts 2>/dev/null');
    expect(r?.decision?.tool).toBe('fff_grep');
  });

  test('strips trailing 2>&1', () => {
    const r = rewrite('ls ~/.pi/agent/ 2>&1');
    expect(r?.decision?.tool).toBe('ls');
  });

  test('strips trailing 2>&1 followed by 2>/dev/null', () => {
    const r = rewrite('cat file 2>&1 2>/dev/null');
    expect(r?.decision?.tool).toBe('read');
  });
});

describe('tryRewriteBash — notice text', () => {
  test('notice is present, references original command and target tool', () => {
    const r = rewrite('grep -rn foo src/');
    expect(r?.notice).toMatch(/grep -rn foo src\//);
    expect(r?.notice).toMatch(/→ fff_grep\(/);
    expect(r?.notice).toMatch(/Prefer fff_grep/);
  });

  test('long commands are truncated in notice', () => {
    const longPath = 'a'.repeat(500);
    const r = rewrite(`cat ${longPath}`);
    expect(r?.notice).toMatch(/\.\.\./);
  });
});

describe('tryRewriteBash — cheap prefix gate', () => {
  // If the fast path is working, these commands should return null WITHOUT
  // shell-quote running. We can't easily introspect that from a black-box test,
  // but we can at least confirm the null result is produced for every common
  // non-candidate shape.
  const NON_CANDIDATES = [
    '',
    '   ',
    'pnpm install',
    'git status',
    'node --version',
    'python3 -c "print(1)"',
    'bash -c "echo hi"',
    'echo hello',
    'for i in a b c; do echo $i; done',
    'if [ -f foo ]; then cat foo; fi',
    'FOO=bar grep foo file',
    '/usr/bin/grep foo file',
    'sudo grep foo /etc/passwd',
    '"grep" foo file',
    'rm -rf /tmp/junk',
    'mkdir -p build && pnpm build',
  ];

  for (const cmd of NON_CANDIDATES) {
    test(`bail: ${JSON.stringify(cmd)}`, () => {
      expect(rewrite(cmd)).toBeNull();
    });
  }

  test('rejects commands over 4 KB (likely heredoc / inline script)', () => {
    const giant = 'grep foo ' + 'x'.repeat(5000);
    expect(rewrite(giant)).toBeNull();
  });

  test('rejects multi-line commands (heredocs, inline scripts, for/while bodies)', () => {
    expect(rewrite('grep foo \\\n  file.ts')).toBeNull();
    expect(rewrite('grep foo file.ts\ngrep bar file.ts')).toBeNull();
  });

  test('still accepts commands just under the length cap', () => {
    const padded = 'grep foo ' + 'x'.repeat(1000);
    const r = rewrite(padded);
    expect(r?.decision.tool).toBe('fff_grep');
  });
});
