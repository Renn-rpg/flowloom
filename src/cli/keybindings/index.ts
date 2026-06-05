// 按键绑定引擎 barrel export。
// 其余模块统一从此 import，避免路径漂移。

export type { Key, Keybinding, KeybindingContext, KeybindingAction, KeybindingMatch, KeyPattern } from './types.js'
export { decodeKey } from './decode-key.js'
export { DEFAULTS } from './defaults.js'
export { loadKeybindings, type LoadResult } from './load.js'
export { keyToPattern, matchKey, buildIndex, type BindingIndex } from './match.js'
export { ContextManager, createContextManager } from './context.js'
export { validateKeybindingConfig, validateBinding, type ValidationResult } from './validate.js'
export { keybindingConfigSchema, keybindingSchema, contextSchema, keyPatternSchema } from './schema.js'
