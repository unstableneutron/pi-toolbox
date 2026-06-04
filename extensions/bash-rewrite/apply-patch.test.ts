import { describe, expect, test } from 'vitest';

import { tryRewriteApplyPatchCliBash } from './apply-patch';

const PATCH = `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch
`;

function command(body = PATCH, delimiter = 'PATCH') {
  return `apply_patch <<'${delimiter}'\n${body}${delimiter}`;
}

describe('tryRewriteApplyPatchCliBash', () => {
  test('rewrites a quoted apply_patch heredoc when apply_patch is available', () => {
    const result = tryRewriteApplyPatchCliBash(command(), {
      availableTools: ['read', 'bash', 'apply_patch'],
    });

    expect(result).toEqual({
      decision: {
        tool: 'apply_patch',
        params: { patch: PATCH },
        recognizer: 'apply-patch-heredoc',
      },
      notice: 'apply_patch CLI → apply_patch(patch=4 lines, 61 bytes)',
    });
  });

  test('returns null when apply_patch is not available', () => {
    expect(
      tryRewriteApplyPatchCliBash(command(), {
        availableTools: ['read', 'bash'],
      }),
    ).toBeNull();
  });

  test('accepts pi getAllTools-style tool objects', () => {
    const result = tryRewriteApplyPatchCliBash(command(), {
      availableTools: [{ name: 'bash' }, { name: 'apply_patch' }],
    });

    expect(result?.decision.params).toEqual({ patch: PATCH });
  });

  test('supports unquoted heredoc delimiters', () => {
    const result = tryRewriteApplyPatchCliBash(`apply_patch <<PATCH\n${PATCH}PATCH`, {
      availableTools: ['apply_patch'],
    });

    expect(result?.decision.params).toEqual({ patch: PATCH });
  });

  test('rejects extra shell commands after the heredoc terminator', () => {
    expect(
      tryRewriteApplyPatchCliBash(`${command()}\nrm -rf /tmp/nope`, {
        availableTools: ['apply_patch'],
      }),
    ).toBeNull();
  });

  test('rejects unsupported apply_patch CLI arguments', () => {
    expect(
      tryRewriteApplyPatchCliBash(`apply_patch --check <<'PATCH'\n${PATCH}PATCH`, {
        availableTools: ['apply_patch'],
      }),
    ).toBeNull();
  });
});
