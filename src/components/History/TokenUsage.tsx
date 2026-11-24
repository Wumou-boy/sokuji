// Token usage shown beside saved History records and for sessions that have no transcript entry.
import { useSessionTokenStore } from '../../lib/usage/sessionTokens';
import type { SessionTokenRecord, SessionTokens } from '../../lib/usage/sessionTokens';
import './History.scss';

const localeOf = (language: string) => language.toLowerCase().startsWith('zh') ? 'zh' : language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
const labelsFor = (language: string) => {
  const locale = localeOf(language);
  if (locale === 'zh') return {
    title: 'Token 用量', input: '输入', output: '输出', notes: '纪要', meeting: '会议', face: '面对面',
    unknown: 'Token 用量未记录', notReported: '服务未报告用量', noSessions: '暂无独立会话记录',
  };
  if (locale === 'ja') return {
    title: 'トークン使用量', input: '入力', output: '出力', notes: 'ノート', meeting: 'ミーティング', face: '対面',
    unknown: 'トークン使用量は記録されていません', notReported: 'サービスから使用量が報告されていません', noSessions: '個別のセッション記録はありません',
  };
  return {
    title: 'Token usage', input: 'Input', output: 'Output', notes: 'Notes', meeting: 'Meeting', face: 'Face to face',
    unknown: 'Token usage was not recorded', notReported: 'Usage was not reported by the service', noSessions: 'No standalone session records',
  };
};

const intlLocale = (language: string) => language.replace(/_/g, '-');
const number = (value: number, language: string) => new Intl.NumberFormat(intlLocale(language)).format(value);
const sum = (records: readonly SessionTokens[], key: 'inputTokens' | 'outputTokens' | 'totalTokens') =>
  records.reduce((total, record) => total + record[key], 0);

export function recordsForHistoryId(records: readonly SessionTokenRecord[], historyId: string): SessionTokenRecord[] {
  return records.filter((record) => record.historyId === historyId);
}

export function TokenUsageLine({ records, language, prefix }: { records: readonly SessionTokens[]; language: string; prefix?: 'notes' }) {
  const labels = labelsFor(language);
  if (records.length === 0) return null;
  const input = sum(records, 'inputTokens');
  const output = sum(records, 'outputTokens');
  const total = sum(records, 'totalTokens');
  return (
    <span className="history-token-line" aria-label={`${labels.title}: ${number(total, language)}`}>
      {prefix && <b>{labels.notes}</b>}
      <span>{number(total, language)} Tokens</span>
      <span>{labels.input} {number(input, language)}</span>
      <span>{labels.output} {number(output, language)}</span>
      {records.some((record) => !record.reported) && <small>{labels.notReported}</small>}
    </span>
  );
}

/** Collapsed by default so token accounting is available without crowding the session list. */
export function TokenHistorySummary({ records, language }: { records: readonly SessionTokenRecord[]; language: string }) {
  const labels = labelsFor(language);
  if (records.length === 0) return null;
  // Linked records are already shown inline and on their own History page. Entries without a matching saved
  // transcript stay visible here, including Face to Face and sessions for which History was disabled.
  const standalone = records.filter((record) => !record.historyId);
  const total = sum(records, 'totalTokens');
  const input = sum(records, 'inputTokens');
  const output = sum(records, 'outputTokens');
  return (
    <details className="history-token-history">
      <summary>
        <span>{labels.title}</span>
        <span className="history-token-history__total">{number(total, language)} Tokens</span>
      </summary>
      <div className="history-token-history__body">
        <div className="history-token-history__totals">
          <span>{labels.input} {number(input, language)}</span>
          <span>{labels.output} {number(output, language)}</span>
        </div>
        {standalone.length === 0
          ? <p className="history-token-history__empty">{labels.noSessions}</p>
          : <ul className="history-token-history__rows">
            {standalone.map((record) => (
              <li key={record.id}>
                <span className="history-token-history__session">
                  <span>{record.activity === 'face-to-face' ? labels.face : labels.meeting}</span>
                  <time dateTime={new Date(record.startedAt).toISOString()}>{new Intl.DateTimeFormat(intlLocale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(record.startedAt)}</time>
                  {!record.reported && <small>{labels.notReported}</small>}
                </span>
                <span className="history-token-history__counts">
                  <span>{number(record.totalTokens, language)} Tokens</span>
                  <small>{labels.input} {number(record.inputTokens, language)} · {labels.output} {number(record.outputTokens, language)}</small>
                </span>
              </li>
            ))}
          </ul>}
      </div>
    </details>
  );
}

/** Detail-only zero state: distinguish old or unreported sessions from zero-token sessions. */
export function TokenUsageUnknown({ language }: { language: string }) {
  return <span className="history-token-unknown">{labelsFor(language).unknown}</span>;
}

export default function HistoryTokenUsage({ language }: { language: string }) {
  const records = useSessionTokenStore((state) => state.history);
  return <TokenHistorySummary records={records} language={language} />;
}
