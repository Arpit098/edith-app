// Commands: run EDITH's server commands (/today, /mail, /reminders, /brief, …) from a Tools tile.

import type { FeatureModule } from '../../core/feature';
import { CommandsScreen } from './CommandsScreen';
import { createCommandsModel, type CommandsModel } from './model';

let model: CommandsModel | null = null;

function Screen() {
  return model ? <CommandsScreen model={model} /> : null;
}

const commands: FeatureModule = {
  id: 'commands',
  screens: [{ name: 'commands', title: 'Commands', component: Screen }],
  tool: { title: 'Commands', icon: 'console-line', screen: 'commands' },
  setup: ({ bus, api }) => {
    const m = createCommandsModel(bus, api);
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default commands;
