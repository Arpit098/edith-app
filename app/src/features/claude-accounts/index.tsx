// Claude accounts: switch EDITH and the coding agents between saved Claude logins, from Settings
// (contracts/accounts.md).

import type { FeatureModule } from '../../core/feature';
import { AccountsSection } from './AccountsSection';
import { createAccountsModel, type AccountsModel } from './model';

let model: AccountsModel | null = null;

function Section() {
  return model ? <AccountsSection model={model} /> : null;
}

const claudeAccounts: FeatureModule = {
  id: 'claude-accounts',
  settings: [{ title: 'Claude accounts', component: Section }],
  setup: ({ bus, api }) => {
    const m = createAccountsModel(bus, api);
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default claudeAccounts;
