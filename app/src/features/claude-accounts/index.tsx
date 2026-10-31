// Claude accounts: switch EDITH and the coding agents between saved Claude logins, from Settings
// (contracts/accounts.md).

import type { FeatureModule } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { AccountsSection } from './AccountsSection';
import { createAccountsModel, type AccountsModel } from './model';
import { accountsSummary } from './summary';

let model: AccountsModel | null = null;

function Section() {
  return model ? <AccountsSection model={model} /> : null;
}

function useSummary() {
  return useStoreOr(model?.store, accountsSummary, null);
}

const claudeAccounts: FeatureModule = {
  id: 'claude-accounts',
  settings: [{ title: 'Claude accounts', component: Section, group: 'connection', icon: 'account-multiple-outline', order: 10, summary: useSummary }],
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
