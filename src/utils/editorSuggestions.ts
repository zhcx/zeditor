/**
 * 「启用自动补全」开关到 Monaco 建议选项的映射。
 *
 * Monaco 的单词建议默认开启，而项目此前把 `quickSuggestions` 与
 * `suggestOnTriggerCharacters` 硬编码为 false，导致设置里的开关不产生任何效果。
 * 关闭时连单词建议一起关掉，避免「开关已关但仍弹出补全」。
 */
export interface AutoCompleteOptions {
  quickSuggestions: boolean;
  suggestOnTriggerCharacters: boolean;
  wordBasedSuggestions: 'off' | 'currentDocument';
  suggest: { showWords: boolean };
}

export function autoCompleteOptions(enabled: boolean): AutoCompleteOptions {
  return {
    quickSuggestions: enabled,
    suggestOnTriggerCharacters: enabled,
    wordBasedSuggestions: enabled ? 'currentDocument' : 'off',
    suggest: { showWords: enabled },
  };
}
