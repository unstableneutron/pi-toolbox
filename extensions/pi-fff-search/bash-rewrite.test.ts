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
  test('plain grep PAT FILE → fff_grep with dir+glob split (not within=<file>)', () => {
    // Splitting avoids backend-specific file-as-within normalization bugs
    // (e.g. BUILD.bazel silently searched in parent dir and filtered out).
    const r = rewrite('grep foo src/router.ts');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['foo'], within: 'src', glob: 'router.ts', literal: true },
    });
  });

  test('grep -n PAT PATH → ignored flag (fff already returns line numbers)', () => {
    const r = rewrite('grep -n "createLsToolDefinition" file.ts');
    expect(r?.decision?.params).toEqual({
      patterns: ['createLsToolDefinition'],
      within: '.',
      glob: 'file.ts',
      literal: true,
    });
  });

  test('grep -rn PAT PATH → bundled short flags', () => {
    const r = rewrite('grep -rn "pi-update" mise.toml');
    expect(r?.decision).toMatchObject({ tool: 'fff_grep' });
  });

  test('grep -i case-insensitive', () => {
    const r = rewrite('grep -i hello file.ts');
    expect(r?.decision?.params).toMatchObject({ case_sensitive: false });
  });

  test('grep -F literal', () => {
    const r = rewrite('grep -F "foo(bar)" file.ts');
    expect(r?.decision?.params).toMatchObject({ literal: true });
  });

  test('egrep treated as -E regex — alternation splits, literal upgrades for identifier set', () => {
    const r = rewrite('egrep "foo|bar" f.ts');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['foo', 'bar'],
      literal: true,
    });
  });

  test('egrep with regex-meta alternatives keeps literal: false', () => {
    const r = rewrite('egrep "foo.*|bar" f.ts');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['foo.*', 'bar'],
      literal: false,
    });
  });

  test('grep -A 5 context', () => {
    const r = rewrite('grep -A 5 foo file.ts');
    expect(r?.decision?.params).toMatchObject({ context_lines: 5 });
  });

  test('grep -A5 bundled context', () => {
    const r = rewrite('grep -A5 foo file.ts');
    expect(r?.decision?.params).toMatchObject({ context_lines: 5 });
  });

  test('grep --include=*.ts', () => {
    const r = rewrite('grep --include="*.ts" pattern src/');
    expect(r?.decision?.params).toMatchObject({ glob: '*.ts' });
  });

  test('grep --exclude-dir=node_modules', () => {
    const r = rewrite('grep --exclude-dir=node_modules foo src/');
    expect(r?.decision?.params).toMatchObject({ exclude_paths: ['node_modules'] });
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
    // `-x` is a simple identifier → literal=true; `file.ts` splits into dir+glob.
    expect(r?.decision?.params).toMatchObject({
      patterns: ['-x'],
      within: '.',
      glob: 'file.ts',
      literal: true,
    });
  });

  // --- Alternation splitting -------------------------------------------------
  //
  // grep's BRE default treats `\|` as alternation but fff_grep's regex engine
  // treats `\|` as a literal pipe. Pushing the whole pattern through with
  // literal=false produces zero matches. Since fff_grep's `patterns` array is
  // OR-matched, splitting into separate entries is the clean translation.

  test('grep BRE alternation \\| → split into patterns array, literal=true for simple identifiers', () => {
    const r = rewrite('grep -n "stubAuthInvoker\\|stubAuthOutcome" file.go');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: {
        patterns: ['stubAuthInvoker', 'stubAuthOutcome'],
        literal: true,
        within: '.',
        glob: 'file.go',
      },
    });
  });

  test('grep BRE alternation with 4 alternatives → all split', () => {
    const r = rewrite(
      'grep -n "stubAuthInvoker\\|type stubAuth\\|byServer\\|ManifestLoader" connect_test.go',
    );
    expect(r?.decision?.params).toMatchObject({
      patterns: ['stubAuthInvoker', 'type stubAuth', 'byServer', 'ManifestLoader'],
      literal: true,
      within: '.',
      glob: 'connect_test.go',
    });
  });

  test('grep -rn BRE alternation with | head -N → split + limit', () => {
    const r = rewrite('grep -rn "stubAuthInvoker\\|stubAuthOutcome" src/ | head -10');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['stubAuthInvoker', 'stubAuthOutcome'],
      literal: true,
      within: 'src/',
      limit: 10,
    });
  });

  test('egrep ERE alternation → split on unescaped |', () => {
    const r = rewrite('egrep "foo|bar|baz" file.ts');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['foo', 'bar', 'baz'],
      literal: true,
    });
  });

  test('grep -E ERE alternation → split on unescaped |', () => {
    const r = rewrite('grep -E "alpha|beta" file.ts');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['alpha', 'beta'],
      literal: true,
    });
  });

  test('egrep ERE with escaped pipe → do NOT split, preserve literal pipe', () => {
    const r = rewrite('egrep "foo\\|bar" file.ts');
    // `\|` in ERE = literal pipe; there is no alternation to split on.
    expect(r?.decision?.params.patterns).toEqual(['foo\\|bar']);
  });

  test('fgrep with literal | → do NOT split', () => {
    const r = rewrite('fgrep "foo|bar" file.ts');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['foo|bar'],
      literal: true,
    });
  });

  test('grep -F with literal | → do NOT split', () => {
    const r = rewrite('grep -F "foo|bar" file.ts');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['foo|bar'],
      literal: true,
    });
  });

  test('grep BRE alternation with regex meta → split, but keep literal=false', () => {
    const r = rewrite('grep -n "foo.*\\|bar\\[0-9\\]" file.ts');
    // One alternative has `.*`, so we cannot claim literal-safety for the set.
    expect(r?.decision?.params.patterns).toEqual(['foo.*', 'bar\\[0-9\\]']);
    expect(r?.decision?.params.literal).toBe(false);
  });

  test('grep BRE alternation with empty alternative → no split (pass the raw pattern)', () => {
    // `a\|\|b` has an empty middle alternative — ambiguous, don't split.
    const r = rewrite('grep -n "a\\|\\|b" file.ts');
    expect(r?.decision?.params.patterns).toEqual(['a\\|\\|b']);
  });

  // --- BRE-only escapes beyond alternation ----------------------------------
  //
  // GNU BRE's `\(`, `\)`, `\{`, `\}`, `\+`, `\?`, `\<`, `\>`, `\b` mean
  // different things in fff_grep's regex engine. The rewriter can't safely
  // translate them, so it must pass through rather than emit a broken regex.

  test('grep BRE with \\( \\) grouping → pass through', () => {
    expect(rewrite('grep -n "\\(foo\\|bar\\)" file.ts')).toBeNull();
  });

  test('grep BRE with \\+ GNU quantifier → pass through', () => {
    expect(rewrite('grep -n "foo\\+" file.ts')).toBeNull();
  });

  test('grep BRE with \\{1,3\\} counted repetition → pass through', () => {
    expect(rewrite('grep -n "a\\{1,3\\}" file.ts')).toBeNull();
  });

  test('grep BRE with \\< word-start → pass through', () => {
    expect(rewrite('grep -n "\\<foo\\>" file.ts')).toBeNull();
  });

  test('egrep with same metacharacters → rewrite unchanged (ERE semantics match fff_grep)', () => {
    // In ERE, (), {}, +, ? have their PCRE meanings — fff_grep handles them.
    const r = rewrite('egrep "(foo)+" file.ts');
    expect(r?.decision?.params.patterns).toEqual(['(foo)+']);
    expect(r?.decision?.params.literal).toBe(false);
  });

  // --- File-target splitting ------------------------------------------------
  //
  // `grep PAT FILE` must NOT become `fff_grep(within=FILE)` — some FFF router
  // backends normalize a file-as-`within` to the parent directory with default
  // ignore rules applied, producing spurious zero-match results (observed
  // against BUILD.bazel). The translation must split file-like targets into
  // `within=<dir>, glob=<basename>`.

  test('grep PAT ABS_FILE_PATH with no -r → dir+glob split', () => {
    const r = rewrite('grep curl_behavior_test /repo/projects/foo/BUILD.bazel');
    expect(r?.decision?.params).toMatchObject({
      patterns: ['curl_behavior_test'],
      within: '/repo/projects/foo',
      glob: 'BUILD.bazel',
      literal: true,
    });
  });

  test('grep PAT extensionless-known-file → dir+glob split', () => {
    const r = rewrite('grep "foo" /proj/Makefile');
    expect(r?.decision?.params).toMatchObject({ within: '/proj', glob: 'Makefile' });
  });

  test('grep PAT bare-filename-with-ext → dirname=. + glob', () => {
    const r = rewrite('grep foo router.ts');
    expect(r?.decision?.params).toMatchObject({ within: '.', glob: 'router.ts' });
  });

  test('grep PAT trailing-slash DIR → no split, kept as within', () => {
    const r = rewrite('grep foo src/');
    expect(r?.decision?.params).toMatchObject({ within: 'src/' });
    expect(r?.decision?.params.glob).toBeUndefined();
  });

  test('grep -r PAT FILE-LIKE-PATH → recursive intent wins, no split', () => {
    // `-r` signals directory intent even if the path happens to look file-like.
    const r = rewrite('grep -r pi-update mise.toml');
    expect(r?.decision?.params).toMatchObject({ within: 'mise.toml' });
    expect(r?.decision?.params.glob).toBeUndefined();
  });

  test('grep PAT hidden-dotfile → no split (ripgrep default ignore would skip it)', () => {
    const r = rewrite('grep foo .env');
    expect(r?.decision?.params).toMatchObject({ within: '.env' });
    expect(r?.decision?.params.glob).toBeUndefined();
  });

  test('grep PAT bare-name-no-extension → no split (ambiguous file/dir)', () => {
    const r = rewrite('grep foo src');
    expect(r?.decision?.params).toMatchObject({ within: 'src' });
    expect(r?.decision?.params.glob).toBeUndefined();
  });

  test('grep --include=*.ts PAT FILE → honour explicit glob, do not overwrite with split', () => {
    const r = rewrite('grep --include="*.ts" foo src/router.ts');
    // User-supplied glob takes precedence; within stays as the file path.
    expect(r?.decision?.params).toMatchObject({ within: 'src/router.ts', glob: '*.ts' });
  });

  // --- Full end-to-end field-report cases ----------------------------------
  //
  // These are real agent-traffic commands that previously returned
  // `(no matches)`. They exercise the combination of:
  //   - BRE alternation splitting (from the `\|` fix),
  //   - file-target dir+glob splitting (from the BUILD.bazel fix),
  //   - mixed literal and regex alternatives (keep literal=false).
  // Any regression here corresponds to an agent session wasting a turn.

  test('e2e: huh field_select — 4 alternatives, one with .*, file target, absolute path', () => {
    const r = rewrite(
      'grep -n "updateViewportHeight\\|defaultHeight\\|height ==\\|if.*height" ' +
        '/Users/thinh_nguyen/go/pkg/mod/github.com/charmbracelet/huh@v0.8.0/field_select.go | head -15',
    );
    expect(r?.decision?.tool).toBe('fff_grep');
    expect(r?.decision?.params.patterns).toEqual([
      'updateViewportHeight',
      'defaultHeight',
      'height ==',
      'if.*height',
    ]);
    // One alternative has `.*` → can't claim literal-safety; keep regex mode.
    expect(r?.decision?.params.literal).toBe(false);
    expect(r?.decision?.params.within).toBe(
      '/Users/thinh_nguyen/go/pkg/mod/github.com/charmbracelet/huh@v0.8.0',
    );
    expect(r?.decision?.params.glob).toBe('field_select.go');
    expect(r?.decision?.params.limit).toBe(15);
  });

  test('e2e: ergo connect.go — leading `cd`, 2 alternatives, unescaped . in one alternative', () => {
    // Field report: user ran
    //   cd /Users/thinh_nguyen/airlab/repos/ergo && grep -n "unknown server\|run .airchat-toolbox manifest" projects/.../connect.go
    // and got `(no matches)` because the rewriter passed the whole BRE
    // pattern through as a single regex string with `\|` as literal pipe.
    // After the alternation-split fix, the rewrite must:
    //   - strip the leading `cd <path> &&` navigation,
    //   - split on `\|` into two alternatives,
    //   - keep `literal: false` because the second alternative contains `.`
    //     (a regex meta), so the set isn't literal-safe,
    //   - split the file target into within=<dir> + glob=<basename>.
    const r = rewrite(
      'cd /Users/thinh_nguyen/airlab/repos/ergo && ' +
        'grep -n "unknown server\\|run .airchat-toolbox manifest" ' +
        'projects/airchat/cli/toolbox/cmd/connect.go',
    );
    expect(r?.decision?.tool).toBe('fff_grep');
    expect(r?.decision?.params.patterns).toEqual([
      'unknown server',
      'run .airchat-toolbox manifest',
    ]);
    expect(r?.decision?.params.literal).toBe(false);
    expect(r?.decision?.params.within).toBe('projects/airchat/cli/toolbox/cmd');
    expect(r?.decision?.params.glob).toBe('connect.go');
  });

  test('e2e: huh field_select — 2 alternatives, one escaped dot (\\.), file target', () => {
    const r = rewrite(
      'grep -n "updateViewportHeight\\|s\\.height" ' +
        '/Users/thinh_nguyen/go/pkg/mod/github.com/charmbracelet/huh@v0.8.0/field_select.go | head -15',
    );
    expect(r?.decision?.params.patterns).toEqual(['updateViewportHeight', 's\\.height']);
    // `s\.height` contains backslash → keep regex mode; fff_grep's engine
    // interprets `\.` as a literal dot, which matches the user's intent.
    expect(r?.decision?.params.literal).toBe(false);
    expect(r?.decision?.params.within).toBe(
      '/Users/thinh_nguyen/go/pkg/mod/github.com/charmbracelet/huh@v0.8.0',
    );
    expect(r?.decision?.params.glob).toBe('field_select.go');
    expect(r?.decision?.params.limit).toBe(15);
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

  // Extension-only globs carry no fuzzy-search signal. Bail out regardless of
  // whether the extension happens to be in our legacy generic-tokens list.
  test('find PATH -name "*.go" → pass through (extension-only, not in generic tokens)', () => {
    // Regression: prior to the structural check, `go` wasn't in
    // FIND_QUERY_GENERIC_TOKENS so this rewrote to `query: "go"` and
    // returned zero results against FFF-routed hidden dirs.
    expect(rewrite('find /tmp/huhsrc/node_modules/.gitchamber -name "*.go"')).toBeNull();
  });

  test('find PATH -name "*.go" | head -5 → pass through even with head', () => {
    expect(
      rewrite('find /tmp/huhsrc/node_modules/.gitchamber -name "*.go" 2>&1 | head -5'),
    ).toBeNull();
  });

  for (const ext of ['py', 'rs', 'rb', 'java', 'c', 'cpp', 'h', 'hpp', 'swift', 'kt', 'scala']) {
    test(`find PATH -name "*.${ext}" → pass through (no fuzzy signal)`, () => {
      expect(rewrite(`find /repo -name "*.${ext}"`)).toBeNull();
    });
  }

  test('find PATH -name "**/*.go" → pass through (recursive extension-only)', () => {
    expect(rewrite('find /repo -name "**/*.go"')).toBeNull();
  });

  test('find PATH -name "*router*.go" → rewrites (has a non-extension token)', () => {
    const r = rewrite('find /repo -name "*router*.go"');
    expect(r?.decision?.tool).toBe('fff_find_files');
    expect(r?.decision?.params.query).toBe('router');
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
  // The notice is designed to be token-frugal: a single line of the form
  //   `<source> → <target>(<params>)`
  // with no original-command echo, no multi-line pedagogy, and no truncation.
  // The source-tool prefix disambiguates the arrow direction, confirms
  // which bash tool the rewriter recognized, and teaches the mapping by
  // exposure. See formatNotice in bash-rewrite.ts.

  test('notice starts with the source tool and target tool call', () => {
    const r = rewrite('grep -rn foo src/');
    expect(r?.notice).toMatch(/^grep → fff_grep\(/);
  });

  test('notice distinguishes source tool flavors (grep vs egrep vs fgrep vs rg)', () => {
    expect(rewrite('egrep "a|b" f.ts')?.notice).toMatch(/^egrep → fff_grep\(/);
    expect(rewrite('fgrep "foo" f.ts')?.notice).toMatch(/^fgrep → fff_grep\(/);
    expect(rewrite('rg "foo" src/')?.notice).toMatch(/^rg → fff_grep\(/);
  });

  test('notice labels find, cat, ls, head, sed, fd correctly', () => {
    expect(rewrite('cat src/foo.ts')?.notice).toMatch(/^cat → read\(/);
    expect(rewrite('ls src/')?.notice).toMatch(/^ls → ls\(/);
    expect(rewrite('head -5 src/foo.ts')?.notice).toMatch(/^head → read\(/);
    expect(rewrite("sed -n '10,20p' src/foo.ts")?.notice).toMatch(/^sed → read\(/);
    expect(rewrite('find src/ -name "*router*"')?.notice).toMatch(/^find → fff_find_files\(/);
    expect(rewrite('fd router src/')?.notice).toMatch(/^fd → fff_find_files\(/);
  });

  test('notice keeps the source label even with `+head` pipeline suffix', () => {
    // Pipeline recognizers append `+head`; the source segment must still
    // be the first `-`- or `+`-separated token.
    const r = rewrite('grep -rn foo src/ | head -10');
    expect(r?.notice).toMatch(/^grep → fff_grep\(/);
  });

  test('notice is a single line', () => {
    const r = rewrite('grep -rn foo src/');
    expect(r?.notice?.includes('\n')).toBe(false);
  });

  test('notice contains the structured params', () => {
    const r = rewrite('grep -rn foo src/');
    expect(r?.notice).toMatch(/patterns=\["foo"\]/);
    expect(r?.notice).toMatch(/within="src\/"/);
  });

  test('notice does NOT echo the original command', () => {
    // The agent already knows what they ran; echoing costs tokens for no gain.
    const r = rewrite('grep -rn foo src/');
    expect(r?.notice).not.toMatch(/grep -rn foo/);
  });

  test('notice does NOT carry the old pedagogical tail', () => {
    const r = rewrite('grep -rn foo src/');
    expect(r?.notice).not.toMatch(/Prefer fff_grep/);
    expect(r?.notice).not.toMatch(/skip shell parsing/);
  });

  test('notice stays short even for long commands (no truncation needed)', () => {
    // With the command echo gone, there's nothing to truncate — the notice
    // is bounded by the structured-tool param size, not the input.
    const longPath = 'a'.repeat(500);
    const r = rewrite(`cat ${longPath}`);
    expect(r?.notice).not.toMatch(/\.\.\./);
    // Should stay well under the old ~280-char baseline.
    expect(r?.notice?.length ?? 0).toBeLessThan(640);
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
    // NOTE: `/usr/bin/grep foo file` is now a candidate (see the
    // "absolute-path builtin prefix" suite). Keep sudo/quoted-command
    // shapes here since they still bail.
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
    expect(r?.decision?.tool).toBe('fff_grep');
  });
});

describe('tryRewriteBash — sed line-range → read', () => {
  test("sed -n '1,20p' FILE → read with offset/limit", () => {
    const r = rewrite("sed -n '1,20p' src/router.ts");
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'src/router.ts', offset: 1, limit: 20 },
      recognizer: 'sed-range-print',
    });
  });

  test("sed -n '42p' FILE → read with single-line window", () => {
    const r = rewrite("sed -n '42p' foo.ts");
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'foo.ts', offset: 42, limit: 1 },
    });
  });

  test("sed -n '10,50p' FILE | head -5 → limit overridden to 5", () => {
    const r = rewrite("sed -n '10,50p' foo.ts | head -5");
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'foo.ts', offset: 10, limit: 5 },
    });
    expect(r?.decision?.recognizer).toBe('sed-range-print+head');
  });

  test('rejects sed with regex range', () => {
    expect(rewrite("sed -n '/foo/,/bar/p' f.ts")).toBeNull();
  });

  test('rejects sed with substitution', () => {
    expect(rewrite("sed -n 's/foo/bar/p' f.ts")).toBeNull();
  });

  test('rejects sed with multiple expressions via semicolon', () => {
    expect(rewrite("sed -n '1,5p;10,15p' f.ts")).toBeNull();
  });

  test('rejects sed without -n (not a pure range-print idiom)', () => {
    expect(rewrite("sed '1,5p' f.ts")).toBeNull();
  });

  test('rejects sed -i (in-place edit — unsafe to reroute)', () => {
    expect(rewrite("sed -i 's/foo/bar/g' f.ts")).toBeNull();
  });

  test('rejects reverse range N > M', () => {
    expect(rewrite("sed -n '50,10p' f.ts")).toBeNull();
  });
});

describe('tryRewriteBash — cat -A notice-only (BSD cat incompatibility)', () => {
  test('cat -A FILE → notice-only, no decision', () => {
    const r = rewrite('cat -A file.ts');
    expect(r).not.toBeNull();
    expect(r!.decision).toBeUndefined();
    expect(r!.notice).toMatch(/BSD `cat`/);
    expect(r!.notice).toMatch(/cat -vet/);
  });

  test('cat -vET FILE (GNU bundled) → notice', () => {
    const r = rewrite('cat -vET file.ts');
    expect(r).not.toBeNull();
    expect(r!.decision).toBeUndefined();
    expect(r!.notice).toMatch(/BSD `cat`/);
  });

  test('cat --show-all FILE → notice', () => {
    const r = rewrite('cat --show-all file.ts');
    expect(r).not.toBeNull();
    expect(r!.decision).toBeUndefined();
  });

  test('cat -A FILE | head -12 (pipeline) → notice, no decision', () => {
    const r = rewrite('cat -A file.ts | head -12');
    expect(r).not.toBeNull();
    expect(r!.decision).toBeUndefined();
    expect(r!.notice).toMatch(/BSD `cat`/);
  });

  test('cat -A FILE | od -c (unsupported pipeline) → notice, no decision', () => {
    // Two-stage pipeline where stage 2 is not `head -N` — we still
    // surface the notice so the agent sees the BSD fix.
    const r = rewrite('cat -A file.ts | od -c');
    expect(r).not.toBeNull();
    expect(r!.decision).toBeUndefined();
  });

  test('cat -n FILE stays a pass-through (no -A, no notice)', () => {
    // -n (number lines) is harmless; existing behavior says pass through.
    expect(rewrite('cat -n file.ts')).toBeNull();
  });

  test('cat FILE (no flags) still routes to read, not the notice path', () => {
    const r = rewrite('cat file.ts');
    expect(r?.decision).toMatchObject({ tool: 'read', params: { path: 'file.ts' } });
  });
});

describe('tryRewriteBash — absolute-path builtin prefix', () => {
  test('/usr/bin/grep PAT FILE → fff_grep', () => {
    const r = rewrite('/usr/bin/grep -n foo src/router.ts');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['foo'], within: 'src', glob: 'router.ts' },
      recognizer: 'grep-search',
    });
  });

  test('/opt/homebrew/bin/rg PAT → fff_grep', () => {
    const r = rewrite('/opt/homebrew/bin/rg -i ActorAuth src/');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['ActorAuth'], within: 'src/', case_sensitive: false },
      recognizer: 'rg-search',
    });
  });

  test('/bin/cat FILE → read', () => {
    const r = rewrite('/bin/cat package.json');
    expect(r?.decision).toMatchObject({ tool: 'read', params: { path: 'package.json' } });
  });

  test('cd X && /usr/bin/grep PAT FILE | head -N → fff_grep with limit', () => {
    const r = rewrite('cd /repo/pkg && /usr/bin/grep -n "pub mod" crates/foo/src/lib.rs | head -5');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['pub mod'], limit: 5 },
    });
  });

  test('/usr/local/bin/fd PAT DIR → fff_find_files', () => {
    const r = rewrite('/usr/local/bin/fd router src/');
    expect(r?.decision).toMatchObject({
      tool: 'fff_find_files',
      params: { query: 'router', within: 'src/' },
    });
  });

  test('unknown absolute path (e.g. /opt/mytool/bin/grep) → pass through', () => {
    // Only the standard builtin locations are stripped. User-installed tools
    // at other paths must keep the full path and get no rewrite.
    expect(rewrite('/opt/mytool/bin/grep foo bar.ts')).toBeNull();
  });
});

describe('tryRewriteBash — leading `command` shell-builtin prefix', () => {
  test('command grep PAT FILE → fff_grep', () => {
    const r = rewrite('command grep -n foo src/router.ts');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['foo'], within: 'src', glob: 'router.ts' },
    });
  });

  test('command cat FILE → read', () => {
    const r = rewrite('command cat package.json');
    expect(r?.decision).toMatchObject({ tool: 'read', params: { path: 'package.json' } });
  });

  test('command /usr/bin/grep PAT FILE → fff_grep (both prefixes stripped)', () => {
    const r = rewrite('command /usr/bin/grep -n foo src/router.ts');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['foo'] },
    });
  });

  test('cd X && command grep PAT FILE → fff_grep', () => {
    const r = rewrite('cd /repo && command grep "pub mod" src/lib.rs');
    expect(r?.decision).toMatchObject({
      tool: 'fff_grep',
      params: { patterns: ['pub mod'] },
    });
  });

  test('`command` alone without a tool → pass through', () => {
    // Bare `command` is not itself a rewrite target.
    expect(rewrite('command')).toBeNull();
  });
});

describe('tryRewriteBash — cat FILE | sed -n range pipeline', () => {
  test("cat FILE | sed -n '10,50p' → read(offset=10, limit=41)", () => {
    const r = rewrite("cat src/router.ts | sed -n '10,50p'");
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'src/router.ts', offset: 10, limit: 41 },
      recognizer: 'cat-sed-range',
    });
  });

  test("cat FILE | sed -n '42p' → single-line read(offset=42, limit=1)", () => {
    const r = rewrite("cat README.md | sed -n '42p'");
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'README.md', offset: 42, limit: 1 },
      recognizer: 'cat-sed-range',
    });
  });

  test('cd X && cat FILE | sed -n range → read', () => {
    const r = rewrite("cd /tmp && cat a.txt | sed -n '1,5p'");
    expect(r?.decision).toMatchObject({
      tool: 'read',
      params: { path: 'a.txt', offset: 1, limit: 5 },
      recognizer: 'cat-sed-range',
    });
  });

  test('cat FILE | sed with substitution → pass through (not a range read)', () => {
    expect(rewrite("cat a.txt | sed 's/foo/bar/'")).toBeNull();
  });

  test('cat FILE | sed -n with other expression → pass through', () => {
    // `/pattern/p` is a regex address, not a numeric range.
    expect(rewrite("cat a.txt | sed -n '/foo/p'")).toBeNull();
  });
});
