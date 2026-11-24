import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { remainingQuota, useUsageStore } from '../../lib/usage/ledger';
import { BAILIAN_NOTES_MODEL, LIVE_TRANSLATE_MODEL } from '../../lib/usage/providerUsage';
import type { CategoryBodyProps } from './SettingsPage';

const copy = {
  en: {
    model: 'Model', remaining: 'Remaining tokens shown in Bailian', save: 'Update quota',
    estimate: 'Estimated remaining', unsaved: 'The quota could not be saved.',
    snapshot: 'Recorded {{date}} · {{count}} tokens',
    help: 'Enter the remaining free tokens shown for this model in Bailian. The estimate subtracts subsequent use on this device. Update it when switching accounts or when the quota changes.',
  },
  zh: {
    model: '模型', remaining: '百炼显示的剩余 Token', save: '更新额度',
    estimate: '本机推算剩余', unsaved: '额度保存失败。',
    snapshot: '{{date}} 录入 · {{count}} Token',
    help: '录入百炼控制台显示的模型免费额度。应用会扣减此后本机用量，切换账户或额度变化后请重新更新。',
  },
  ja: {
    model: 'モデル', remaining: 'Bailian に表示された残りトークン', save: 'クォータを更新',
    estimate: '推定残量', unsaved: 'クォータを保存できませんでした。',
    snapshot: '{{date}} に記録 · {{count}} トークン',
    help: 'Bailian に表示されたモデルの無料トークン残量を入力してください。この端末での利用分を差し引きます。アカウントやクォータが変わった場合は更新してください。',
  },
};

export function UsageCategory(_props: CategoryBodyProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : i18n.language?.startsWith('ja') ? 'ja' : 'en';
  const text = copy[locale === 'zh-CN' ? 'zh' : locale];
  const rows = useUsageStore((state) => state.rows);
  const quotas = useUsageStore((state) => state.quotas);
  const setQuota = useUsageStore((state) => state.setQuota);
  const [model, setModel] = useState(LIVE_TRANSLATE_MODEL);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState(false);
  const modelId = model.trim();
  const options = [...new Set([LIVE_TRANSLATE_MODEL, BAILIAN_NOTES_MODEL, ...rows.map((row) => row.model), ...Object.keys(quotas)])];
  const snapshot = Object.prototype.hasOwnProperty.call(quotas, modelId) ? quotas[modelId] : undefined;
  const quota = Number(amount);
  const valid = Boolean(modelId && amount.trim() && Number.isSafeInteger(quota) && quota >= 0);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    if (!setQuota(modelId, quota)) { setError(true); return; }
    setAmount('');
    setError(false);
  };

  return (
    <div className="general-category usage-category">
      <p className="usage-category__hint">{text.help}</p>
      <form className="usage-category__quota-form" onSubmit={save}>
        <label>{text.model}<input list="usage-model-options" value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <datalist id="usage-model-options">{options.map((option) => <option key={option} value={option} />)}</datalist>
        <label>{text.remaining}<input type="number" min="0" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
        <button type="submit" className="model-row__btn" disabled={!valid}>{text.save}</button>
      </form>
      {error && <p className="usage-category__error" role="alert">{text.unsaved}</p>}
      {snapshot && (
        <div className="usage-category__projection" aria-live="polite">
          <strong>{text.estimate} · {number(remainingQuota(rows, modelId, snapshot))} Token</strong>
          <span>{text.snapshot.replace('{{date}}', new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(snapshot.capturedAt))
            .replace('{{count}}', number(snapshot.remainingTokens))}</span>
        </div>
      )}
    </div>
  );
}
