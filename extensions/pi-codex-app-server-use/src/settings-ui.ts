import type { Component, SettingItem, SettingsListTheme } from '@earendil-works/pi-tui';
import {
  SettingsList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

import { clampRenderedLinesToWidth, normalizeWidth } from '../../shared/tui-width';

import type { CodexAppServerUseConfigPatch } from './config';

export interface CodexAppServerUseSettingsEditResult {
  project: CodexAppServerUseConfigPatch;
  session: CodexAppServerUseConfigPatch;
  user: CodexAppServerUseConfigPatch;
}

type TabId = 'computerUse' | 'exec';

interface ConfigLevels {
  project: CodexAppServerUseConfigPatch;
  session: CodexAppServerUseConfigPatch;
  user: CodexAppServerUseConfigPatch;
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

function enabledValue(value: boolean | undefined): string {
  if (value === undefined) return 'unset';
  return value ? 'enabled' : 'off';
}

function normalizeValue(value: string): string {
  return value.endsWith(' *') ? value.slice(0, -2) : value;
}

function wrapLineToWidth(line: string, width: number): string[] {
  if (line === '') return [''];

  const safeWidth = normalizeWidth(width);
  if (safeWidth === 0) return [''];

  return wrapTextWithAnsi(line, safeWidth);
}

export class CodexAppServerUseSettingsView implements Component {
  private readonly initialState: CodexAppServerUseSettingsEditResult;
  private state: CodexAppServerUseSettingsEditResult;
  private settingsList: SettingsList;
  private activeTab: TabId = 'computerUse';

  constructor(
    levels: ConfigLevels,
    theme: Theme,
    private readonly done: (result: CodexAppServerUseSettingsEditResult | undefined) => void,
  ) {
    this.initialState = structuredClone(levels);
    this.state = structuredClone(levels);

    const items = this.buildItems();
    this.settingsList = new SettingsList(
      items,
      items.length,
      makeSettingsListTheme(theme),
      (id, newValue) => this.update(id, normalizeValue(newValue)),
      () => this.done(undefined),
    );
  }

  private buildItems(): SettingItem[] {
    return [
      {
        id: 'tab',
        label: 'Tab',
        description: 'Choose which AppServer capability settings to edit.',
        currentValue: this.activeTab === 'computerUse' ? 'Computer Use' : 'Exec Tools',
        values: ['Computer Use', 'Exec Tools'],
      },
      ...this.tabItems(),
      {
        id: 'save',
        label: 'Save',
        description: 'Persist these values and reload Pi resources.',
        currentValue: this.hasChanges() ? 'pending changes' : 'no changes',
        values: ['enter'],
      },
    ];
  }

  private tabItems(): SettingItem[] {
    if (this.activeTab === 'exec') {
      return [
        this.execEnabledItem('session', 'This session: enable'),
        this.execReplaceItem('session', 'This session: replace'),
        this.execModelsItem('session', 'This session: models'),
        this.execEnabledItem('project', 'This project: enable'),
        this.execReplaceItem('project', 'This project: replace'),
        this.execModelsItem('project', 'This project: models'),
        this.execEnabledItem('user', 'All sessions: enable'),
        this.execReplaceItem('user', 'All sessions: replace'),
        this.execModelsItem('user', 'All sessions: models'),
      ];
    }
    return [
      this.computerUseItem('session', 'This session'),
      this.computerUseItem('project', 'This project'),
      this.computerUseItem('user', 'All sessions for this user'),
    ];
  }

  private computerUseItem(
    scope: keyof CodexAppServerUseSettingsEditResult,
    label: string,
  ): SettingItem {
    return {
      id: `computerUse.${scope}`,
      label,
      description: 'Controls Codex Computer Use and browser MCP tools for this scope.',
      currentValue: enabledValue(this.state[scope].computerUse?.enabled),
      values: ['unset', 'enabled', 'off'],
    };
  }

  private execEnabledItem(
    scope: keyof CodexAppServerUseSettingsEditResult,
    label: string,
  ): SettingItem {
    return {
      id: `exec.enabled.${scope}`,
      label,
      description: 'Adds AppServer-backed exec_command/write_stdin for this scope.',
      currentValue: enabledValue(this.state[scope].exec?.enabled),
      values: ['unset', 'enabled', 'off'],
    };
  }

  private execReplaceItem(
    scope: keyof CodexAppServerUseSettingsEditResult,
    label: string,
  ): SettingItem {
    return {
      id: `exec.replaceLocalTools.${scope}`,
      label,
      description: 'When enabled, removes Pi read/bash/edit/write while AppServer exec is active.',
      currentValue: enabledValue(this.state[scope].exec?.replaceLocalTools),
      values: ['unset', 'enabled', 'off'],
    };
  }

  private execModelsItem(
    scope: keyof CodexAppServerUseSettingsEditResult,
    label: string,
  ): SettingItem {
    return {
      id: `exec.models.${scope}`,
      label,
      description: 'Auto limits AppServer exec to GPT/Codex-like models. All enables every model.',
      currentValue: this.state[scope].exec?.models ?? 'unset',
      values: ['unset', 'auto', 'all'],
    };
  }

  private update(id: string, value: string): void {
    if (id === 'save') {
      this.done(structuredClone(this.state));
      return;
    }
    if (id === 'tab') {
      this.activeTab = value === 'Exec Tools' ? 'exec' : 'computerUse';
      this.refreshItems();
      return;
    }
    const parts = id.split('.');
    const kind = parts[0] as TabId | 'exec';
    const field = parts[1];
    const scope = (kind === 'exec' ? parts[2] : parts[1]) as
      | keyof CodexAppServerUseSettingsEditResult
      | undefined;
    if (!scope || !(scope in this.state)) return;
    if (kind === 'computerUse') {
      const next = { ...this.state[scope] };
      if (value === 'unset') delete next.computerUse;
      else next.computerUse = { enabled: value === 'enabled' };
      this.state = { ...this.state, [scope]: next };
    } else {
      const next = { ...this.state[scope] };
      const exec = { ...next.exec };
      if (field === 'enabled') {
        if (value === 'unset') delete exec.enabled;
        else exec.enabled = value === 'enabled';
      } else if (field === 'replaceLocalTools') {
        if (value === 'unset') delete exec.replaceLocalTools;
        else exec.replaceLocalTools = value === 'enabled';
      } else if (field === 'models') {
        if (value === 'unset') delete exec.models;
        else exec.models = value as 'auto' | 'all';
      }
      if (Object.keys(exec).length === 0) delete next.exec;
      else next.exec = exec;
      this.state = { ...this.state, [scope]: next };
    }
    this.refreshItems();
  }

  private hasChanges(): boolean {
    return JSON.stringify(this.state) !== JSON.stringify(this.initialState);
  }

  private refreshItems(): void {
    this.settingsList = new SettingsList(
      this.buildItems(),
      this.buildItems().length,
      (this.settingsList as unknown as { theme: SettingsListTheme }).theme,
      (id, newValue) => this.update(id, normalizeValue(newValue)),
      () => this.done(undefined),
    );
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }

  invalidate(): void {
    this.settingsList.invalidate();
  }

  render(width: number): string[] {
    const lines = [
      ...wrapLineToWidth('Codex AppServer Use', width),
      '',
      ...wrapLineToWidth(
        'Tabs: Computer Use controls native CUA/browser MCP tools. Exec Tools controls AppServer-backed exec_command/write_stdin.',
        width,
      ),
      ...wrapLineToWidth(
        'Precedence is session → project → user → defaults. Defaults keep all optional capabilities off.',
        width,
      ),
      '',
      ...this.settingsList.render(width),
    ];

    return clampRenderedLinesToWidth(lines, width, {
      measure: visibleWidth,
      truncate: (text, maxWidth) => truncateToWidth(text, maxWidth),
    });
  }
}
