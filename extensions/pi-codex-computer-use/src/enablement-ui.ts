import type { Component, SettingItem, SettingsListTheme } from '@earendil-works/pi-tui';
import { SettingsList } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

import type { CodexComputerUseEnablementLevels } from './enablement';

export type CodexComputerUseTriState = 'false' | 'true' | 'unset';

export interface CodexComputerUseEnablementEditResult {
  project: CodexComputerUseTriState;
  session: CodexComputerUseTriState;
  user: CodexComputerUseTriState;
}

function levelToValue(value: boolean | undefined): CodexComputerUseTriState {
  if (value === undefined) return 'unset';
  return value ? 'true' : 'false';
}

function makeSettingsListTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg('accent', theme.bold(text)) : text),
    value: (text, selected) => (selected ? theme.fg('accent', text) : theme.fg('muted', text)),
    description: (text) => theme.fg('muted', text),
    cursor: theme.fg('accent', '› '),
    hint: (text) => theme.fg('dim', text),
  };
}

export class CodexComputerUseEnablementSettingsView implements Component {
  private readonly initialState: CodexComputerUseEnablementEditResult;
  private readonly settingsList: SettingsList;
  private state: CodexComputerUseEnablementEditResult;

  constructor(
    levels: CodexComputerUseEnablementLevels,
    theme: Theme,
    private readonly done: (result: CodexComputerUseEnablementEditResult | undefined) => void,
  ) {
    this.initialState = {
      session: levelToValue(levels.session),
      project: levelToValue(levels.project),
      user: levelToValue(levels.user),
    };
    this.state = { ...this.initialState };

    const values = ['unset', 'true', 'false'];
    const items: SettingItem[] = [
      {
        id: 'session',
        label: 'This session',
        description: 'Overrides project and user settings for only the current Pi session.',
        currentValue: this.formatCurrentValue('session'),
        values,
      },
      {
        id: 'project',
        label: 'This project',
        description: 'Persists to .pi/settings.json for this project.',
        currentValue: this.formatCurrentValue('project'),
        values,
      },
      {
        id: 'user',
        label: 'All sessions for this user',
        description: 'Persists to ~/.pi/agent/settings.json.',
        currentValue: this.formatCurrentValue('user'),
        values,
      },
      {
        id: 'save',
        label: 'Save',
        description: 'Persist these values and reload Pi resources.',
        currentValue: this.formatSaveValue(),
        values: ['enter'],
      },
    ];

    this.settingsList = new SettingsList(
      items,
      items.length,
      makeSettingsListTheme(theme),
      (id, newValue) => {
        if (id === 'save') {
          this.done({ ...this.state });
          return;
        }
        this.state = { ...this.state, [id]: this.normalizeValue(newValue) };
        this.refreshValues();
      },
      () => this.done(undefined),
    );
  }

  private normalizeValue(value: string): CodexComputerUseTriState {
    if (value.endsWith(' *')) return value.slice(0, -2) as CodexComputerUseTriState;
    return value as CodexComputerUseTriState;
  }

  private isDirty(id: keyof CodexComputerUseEnablementEditResult): boolean {
    return this.state[id] !== this.initialState[id];
  }

  private hasChanges(): boolean {
    return this.isDirty('session') || this.isDirty('project') || this.isDirty('user');
  }

  private formatCurrentValue(id: keyof CodexComputerUseEnablementEditResult): string {
    return `${this.state[id]}${this.isDirty(id) ? ' *' : ''}`;
  }

  private formatSaveValue(): string {
    return this.hasChanges() ? 'pending changes' : 'no changes';
  }

  private refreshValues(): void {
    this.settingsList.updateValue('session', this.formatCurrentValue('session'));
    this.settingsList.updateValue('project', this.formatCurrentValue('project'));
    this.settingsList.updateValue('user', this.formatCurrentValue('user'));
    this.settingsList.updateValue('save', this.formatSaveValue());
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }

  invalidate(): void {
    this.settingsList.invalidate();
  }

  render(width: number): string[] {
    return [
      'Codex Computer Use',
      '',
      'Cycle each level with Enter/Space. Rows marked * have pending changes. Effective precedence is session → project → user → default disabled.',
      '',
      ...this.settingsList.render(width),
    ];
  }
}
