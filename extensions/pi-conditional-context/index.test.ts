import { describe, expect, test } from 'vitest';

import piConditionalContextExtension, {
  conditionMatches,
  parseConditionExpression,
  processConditionalContext,
} from './index';

describe('pi-conditional-context', () => {
  test('matches claude-like classes from provider and model id', () => {
    expect(conditionMatches('class=claude', { provider: 'anthropic', id: 'claude-opus-4-8' })).toBe(
      true,
    );
    expect(
      conditionMatches('model=sonnet,opus', { provider: 'anthropic', id: 'claude-sonnet-4-6' }),
    ).toBe(true);
    expect(conditionMatches('model=sonnet,opus', { provider: 'openai', id: 'gpt-5.5' })).toBe(
      false,
    );
  });

  test('parses conditions into an explicit OR-of-AND AST', () => {
    expect(parseConditionExpression('provider=anthropic model=sonnet,opus !id=haiku')).toEqual({
      any: [
        {
          all: [
            { key: 'provider', op: 'includes', values: ['anthropic'], negated: false },
            { key: 'model', op: 'includes', values: ['sonnet', 'opus'], negated: false },
            { key: 'id', op: 'includes', values: ['haiku'], negated: true },
          ],
        },
      ],
    });
  });

  test('keeps matching blocks and strips directive comments', () => {
    const input = [
      '# Global instructions',
      '',
      '<!-- pi:if class=claude -->',
      '## Claude-like models only',
      '- Preface meaningful tool calls in prose.',
      '<!-- pi:endif -->',
      '',
      'Always be concise.',
    ].join('\n');

    expect(
      processConditionalContext(input, { provider: 'anthropic', id: 'claude-opus-4-8' }),
    ).toEqual({
      changed: true,
      text: [
        '# Global instructions',
        '',
        '## Claude-like models only',
        '- Preface meaningful tool calls in prose.',
        '',
        'Always be concise.',
      ].join('\n'),
    });
  });

  test('removes non-matching blocks', () => {
    const input = [
      'Before',
      '<!-- pi:if class=claude -->',
      'Claude-only instruction',
      '<!-- pi:endif -->',
      'After',
    ].join('\n');

    expect(processConditionalContext(input, { provider: 'openai', id: 'gpt-5.5' })).toEqual({
      changed: true,
      text: ['Before', 'After'].join('\n'),
    });
  });

  test('supports else blocks', () => {
    const input = [
      '<!-- pi:if provider=anthropic -->',
      'Claude branch',
      '<!-- pi:else -->',
      'Other branch',
      '<!-- pi:endif -->',
    ].join('\n');

    expect(processConditionalContext(input, { provider: 'openai', id: 'gpt-5.5' }).text).toBe(
      'Other branch',
    );
  });

  test('fails closed for malformed blocks', () => {
    const input = ['Before', '<!-- pi:if class=claude -->', 'Unclosed'].join('\n');

    const result = processConditionalContext(input, { provider: 'openai', id: 'gpt-5.5' });

    expect(result.changed).toBe(true);
    expect(result.text).toContain('Before');
    expect(result.text).not.toContain('Unclosed');
    expect(result.errors).toEqual(['pi-conditional-context: unclosed conditional block']);
  });

  test('fails closed for unknown pi directives', () => {
    const input = ['Before', '<!-- pi:elif class=claude -->', 'Unknown branch'].join('\n');

    const result = processConditionalContext(input, { provider: 'openai', id: 'gpt-5.5' });

    expect(result.changed).toBe(true);
    expect(result.text).toContain('Before');
    expect(result.text).not.toContain('Unknown branch');
    expect(result.errors).toEqual(['pi-conditional-context: unknown directive on line 2']);
  });

  test('rejects top-level OR until syntax proves necessary', () => {
    expect(parseConditionExpression('provider=anthropic || class=codex')).toBeUndefined();
  });

  test('registers a before_agent_start system prompt transform', () => {
    let handler:
      | ((
          event: { systemPrompt: string },
          ctx: { model: { provider: string; id: string }; hasUI?: boolean },
        ) => { systemPrompt: string } | undefined)
      | undefined;
    const pi = {
      on(event: string, next: typeof handler) {
        if (event === 'before_agent_start') handler = next;
      },
    };

    piConditionalContextExtension(pi as never);
    const result = handler?.(
      {
        systemPrompt: [
          '<!-- pi:if class=claude -->',
          'Claude-only instruction',
          '<!-- pi:endif -->',
        ].join('\n'),
      },
      { model: { provider: 'openai', id: 'gpt-5.5' } },
    );

    expect(result).toEqual({ systemPrompt: '' });
  });
});
