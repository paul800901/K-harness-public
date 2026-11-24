import {startDesktop} from '../src/desktop-server.mjs';
import {createComponentPreferences} from '../src/component-preferences.mjs';
import {componentIds} from '../shared/components.mjs';

// These fixtures exercise an already configured workbench. The onboarding probe starts from an empty directory.
export async function startConfiguredDesktop(options, selected = componentIds) {
  const preferences = await createComponentPreferences(options.root);
  await preferences.set(selected);
  return startDesktop(options);
}
