import { useTranslation } from 'react-i18next';
import type { SessionTokens } from '../../lib/usage/sessionTokens';
import './SessionTokenMeter.scss';

interface Props {
  session: SessionTokens | null;
}

/** A small live count for the current provider session, with the breakdown available to assistive tech and on hover. */
export function SessionTokenMeter({ session }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language?.replace(/_/g, '-');
  const zh = locale?.startsWith('zh');
  const ja = locale?.startsWith('ja');
  const number = new Intl.NumberFormat(locale).format;
  const total = session === null ? '—' : number(session.totalTokens);
  const title = session === null
    ? t('mainPanel.sessionTokensUnavailable', zh ? '暂无本场 Token 数据' : ja ? 'このセッションの使用量は取得できません' : 'Session token count unavailable for this provider')
    : t('mainPanel.sessionTokensDetail', zh ? '本场 Token {{total}}，输入 {{input}}，输出 {{output}}，计入额度 {{billable}}{{reported}}'
      : ja ? 'このセッション {{total}} トークン（入力 {{input}}、出力 {{output}}、クォータ対象 {{billable}}）{{reported}}'
        : 'Session tokens: {{total}} total ({{input}} input, {{output}} output; {{billable}} billable){{reported}}', {
      total,
      input: number(session.inputTokens),
      output: number(session.outputTokens),
      billable: number(session.billableTokens),
      reported: session.reported ? '' : zh ? ' · 等待服务回传' : ja ? ' · 使用量を待機中' : ' · waiting for provider usage',
    });

  return (
    <span className="session-token-meter" role="group" title={title} aria-label={title}>
      <span className="session-token-meter__label">{t('mainPanel.sessionTokens', zh ? '本场 Token' : ja ? '今回のトークン' : 'Session tokens')}</span>
      <span className="session-token-meter__value">{total}</span>
    </span>
  );
}
