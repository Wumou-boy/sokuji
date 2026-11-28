import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAnalytics } from '../../lib/analytics';
import { presentProviders } from '../../providers/registry';
import { stageProviderId } from '../../stores/lineUpStore';
import { useProviderStore } from '../../stores/providerStore';
import { CredentialForm } from '../providers/CredentialForm';
import { useAuthContext } from '../providers/useAuthContext';
import type { CategoryBodyProps } from './SettingsPage';
import { ACCOUNT_SERVICES, accountAnchor, accountKeyOf, providerOfTarget } from './accountRows';
import { FindModels } from './FindModels';

export function AccountsCategory({ locked, openedBy = null }: CategoryBodyProps) {
  const { t } = useTranslation();
  const { trackEvent } = useAnalytics();
  const auth = useAuthContext();
  const providers = useMemo(() => {
    const available = presentProviders();
    return ACCOUNT_SERVICES.flatMap((id) => available.filter((provider) => provider.id === id && provider.kind === 'own-key'));
  }, []);
  const entries = useProviderStore((s) => s.entries);
  const readiness = useProviderStore((s) => s.readiness);
  const models = useProviderStore((s) => s.models);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const id = openedBy === 'provider' ? stageProviderId('transcription') : providerOfTarget(openedBy);
    if (id && providers.some((provider) => provider.id === accountKeyOf(id))) setOpen(accountKeyOf(id));
  }, [openedBy, providers]);

  useEffect(() => {
    for (const provider of providers) {
      if (!useProviderStore.getState().entries[provider.id]) void useProviderStore.getState().load(provider);
    }
  }, [providers]);

  return (
    <div className="config-section accounts-category" id="provider-section" data-tour="provider-section">
      {providers.map((provider) => {
        const { id, icon: Icon } = provider;
        const compatible = id === 'openai_compatible';
        const official = id === 'openai';
        const name = compatible ? t('providers.openai_compatible.name', 'OpenAI-Compatible Service') : official ? 'OpenAI' : 'Qwen LiveTranslate';
        const description = compatible
          ? t('settingsPage.accounts.internalModel', 'Company network and PGX text models')
          : official ? t('settingsPage.accounts.endpointInternational', 'International availability (only in regions supported by the provider)')
            : t('settingsPage.accounts.bailianModel', 'Alibaba Cloud Model Studio · real-time translation');
        const entry = entries[id];
        const fields = provider.credentials.fields((entry?.settings ?? provider.settings.defaults) as never);
        const emptyRequired = fields.filter((field) => !field.optional && !String(entry?.credentials[field.key] ?? '').trim());
        const answer = readiness[id] ?? { state: 'unknown' };
        let state = t('settingsPage.accounts.keyNotVerified', 'Key not verified');
        if (emptyRequired.some((field) => field.key === 'baseUrl')) state = t('settingsPage.lineup.state.needsAddress', 'Needs an address');
        else if (emptyRequired.length > 0) state = t('settingsPage.accounts.needsKey', 'Needs a key');
        else if (answer.state === 'ready') state = t('settingsPage.accounts.keySaved', 'Key saved');
        else if (answer.state === 'not-ready' && answer.code === 'auth') state = t('settingsPage.lineup.state.keyRefused', 'Key not accepted');
        const isOpen = open === id;
        return (
          <div className="accounts-row" role="group" aria-label={name} key={id} id={`${accountAnchor(id)}-section`}>
            <div className="accounts-row__head">
              {Icon && <span className="accounts-row__icon" aria-hidden="true"><Icon size={20} /></span>}
              <div className="accounts-row__main">
                <span className="accounts-row__title"><span className="accounts-row__name">{name}</span></span>
                <span className="accounts-row__state">{description}</span>
                <span className={`accounts-row__state${answer.state === 'ready' && !emptyRequired.length ? ' is-ok' : ''}`}>{state}</span>
              </div>
              <button type="button" className="accounts-row__toggle" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
                {isOpen ? t('settingsPage.accounts.hide', 'Hide')
                  : emptyRequired.length > 0
                    ? (compatible ? t('settingsPage.accounts.configure', 'Configure') : t('settingsPage.accounts.addKey', 'Add key'))
                    : t('settingsPage.accounts.view', 'View')}
              </button>
            </div>
            {isOpen && entry && (
              <CredentialForm
                fields={fields}
                values={entry.credentials}
                readiness={answer}
                endpointRegion={compatible ? 'custom' : official ? 'official' : undefined}
                onChange={(key, value) => useProviderStore.getState().setCredential(provider, key, value)}
                choice={provider.credentials.choice && {
                  options: provider.credentials.choice.options,
                  value: String((entry.settings as Record<string, unknown>)[provider.credentials.choice.setting] ?? ''),
                  onChange: (value) => useProviderStore.getState().updateSettings(provider, { [provider.credentials.choice!.setting]: value }),
                }}
                onCheck={() => {
                  void useProviderStore.getState().refreshReadiness(provider, auth).then((result) => {
                    if (result.state === 'unknown' || result.state === 'checking') return;
                    trackEvent('api_key_validated', {
                      provider: id,
                      success: result.state === 'ready',
                      ...(result.state === 'not-ready' && result.code ? { error_type: result.code } : {}),
                    });
                  });
                }}
                disabled={locked}
              />
            )}
            {isOpen && id === 'qwen_livetranslate' && (() => {
              const connection = String((entry?.settings as { connection?: unknown } | undefined)?.connection ?? '');
              const endpoint = connection === 'cn' || connection === 'intl' ? connection : models[id]?.[0]?.id;
              const bailian = connection.startsWith('bailian') || endpoint === 'bailian-cn';
              const domestic = bailian || endpoint === 'cn';
              return <p className="api-key-endpoint-region">{domestic
                ? t('settingsPage.accounts.endpointDomestic', 'Available in mainland China')
                : endpoint === 'intl'
                  ? t('settingsPage.accounts.endpointInternational', 'International availability (only in regions supported by the provider)')
                  : t('settingsPage.accounts.qwenRegionDetected', 'QwenCloud key region is detected when you check the key.')}</p>;
            })()}
            {isOpen && entry && compatible && (
              <>
                <FindModels service="compatible" credentials={entry.credentials} disabled={locked} />
                <p className="accounts-row__state">{t('settingsPage.accounts.internalModelHint', 'Choose or enter the model name under Languages and line-up.')}</p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
