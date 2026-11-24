export const nativeCores = ['codex', 'claude', 'gemini', 'grok', 'deepseek'];
export const modelProviders = [...nativeCores, 'gemma'];
export const componentIds = [
  ...modelProviders,
  'colab',
  'dictation',
  'emma',
  'browser',
  'desktop',
  'google',
  'api',
  'remote',
  'android'
];

// Undefined comes from older servers. Null is a new installation awaiting its first choice.
export const selectionAllows = selection => id => selection === undefined || (selection?.includes(id) ?? false);

export const visibleProviders = enabled =>
  modelProviders.filter(id => enabled(id) || (id === 'gemma' && enabled('colab')));

// The unselected component an existing room runs on; null when it is selected (or only its Colab twin could be).
export function roomComponentOf({provider}, enabled) {
  if (!provider || enabled(provider) || (provider === 'gemma' && enabled('colab'))) return null;
  return provider;
}

export function validateComponents(value) {
  if (!Array.isArray(value) || value.some(id => !componentIds.includes(id))) throw Error('元件清單無效。');
  if (value.includes('android') && !value.includes('remote')) throw Error('Android App 需要手機遠端。');
  return componentIds.filter(id => value.includes(id));
}
