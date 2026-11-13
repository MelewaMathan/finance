import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner, StatCard, TextInput } from '../../components/ui';
import { messageOf } from '../../lib/errors';
import { formatDateTime, shortHash } from '../../lib/format';
import {
  INTEGRITY_TONE,
  SCOPE_LABEL,
  listIntegrityChecks,
  runIntegrityCheck,
  type IntegrityHistoryRow,
  type IntegrityResult,
  type IntegrityRun,
  type IntegrityScope,
} from '../../lib/audit';

/**
 * Integrity checks (M7).
 *
 * The page answers one question with evidence: is the record still the record?
 *
 * Two different things are checked and reported separately, because they fail
 * for different reasons: the audit chain (recomputed row hashes and links) and
 * each loan's payments (recomputed payload hash against the hash recorded when
 * the money moved). "Unanchored" is shown as its own state -- a payment that
 * was never anchored is not evidence of tampering, and it is not proof either.
 */
export function IntegrityPage() {
  const [run, setRun] = useState<IntegrityRun | null>(null);
  const [history, setHistory] = useState<IntegrityHistoryRow[]>([]);
  const [busy, setBusy] = useState<IntegrityScope | null>(null);
  const [locator, setLocator] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      setHistory(await listIntegrityChecks(20));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function check(scope: IntegrityScope) {
    const value = locator.trim();
    setBusy(scope);
    setError(null);
    try {
      const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      const result = await runIntegrityCheck(
        scope,
        scope === 'loan' ? (isId ? { targetId: value } : { ref: value }) : undefined,
      );
      setRun(result);
      await loadHistory();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Integrity checks"
        subtitle="Recompute what can be recomputed and compare it with what was stored: the audit chain row by row, and each payment against the hash anchored on the ledger."
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <Card title="Run a check" description="Every run is recorded in the audit log with its result and the chain head at that moment.">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-900">Audit chain</p>
            <p className="mt-1 text-xs text-slate-500">Recomputes every audit row hash and every link. Cheap enough to run often.</p>
            <button type="button" className="btn-primary mt-3 w-full" onClick={() => void check('audit_chain')} disabled={busy !== null}>
              {busy === 'audit_chain' ? 'Verifying…' : 'Verify the chain'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-900">Chain + every loan ledger</p>
            <p className="mt-1 text-xs text-slate-500">
              Adds every payment's recomputed hash and its on-chain state. This is the "compare the database with the blockchain" run.
            </p>
            <button type="button" className="btn-primary mt-3 w-full" onClick={() => void check('all')} disabled={busy !== null}>
              {busy === 'all' ? 'Verifying…' : 'Verify everything'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-900">One loan</p>
            <p className="mt-1 text-xs text-slate-500">For a dispute file: the loan's payments only.</p>
            <div className="mt-2">
              <TextInput
                value={locator}
                onChange={(event) => setLocator(event.target.value)}
                placeholder="SMF-2026-0001 or loan id"
                aria-label="Loan reference or id"
              />
            </div>
            <button
              type="button"
              className="btn-ghost mt-2 w-full"
              onClick={() => void check('loan')}
              disabled={busy !== null || locator.trim().length === 0}
            >
              {busy === 'loan' ? 'Verifying…' : 'Verify this loan'}
            </button>
          </div>
        </div>
      </Card>

      {run ? <RunResult run={run} /> : null}

      <div className="mt-5">
        <Card title="Previous runs" description="History is itself append-only; a failed run cannot be deleted.">
          {loadingHistory ? (
            <Spinner label="Loading history" />
          ) : history.length === 0 ? (
            <EmptyState title="No checks yet" description="Run one above. The result is stored with the chain head it saw." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Scope</th>
                    <th>Run by</th>
                    <th className="text-right">Records</th>
                    <th className="text-right">Mismatches</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap">{formatDateTime(row.createdAt)}</td>
                      <td>
                        {SCOPE_LABEL[row.scope] ?? row.scope}
                        {row.targetId ? <span className="block font-mono text-[11px] text-slate-400">{row.targetId.slice(0, 8)}…</span> : null}
                      </td>
                      <td>{row.runBy ?? '—'}</td>
                      <td className="text-right">{row.recordsChecked}</td>
                      <td className="text-right">{row.mismatches}</td>
                      <td>
                        <Badge tone={INTEGRITY_TONE[row.result]}>{row.result}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RunResult({ run }: { run: IntegrityRun }) {
  const chain = run.detail.chain;
  const loans = run.detail.loans ?? [];
  const verdict = run.result as IntegrityResult;

  return (
    <div className="mt-5">
      <Card
        title="Latest result"
        actions={<Badge tone={INTEGRITY_TONE[verdict]}>{verdict === 'ok' ? 'Records match' : verdict}</Badge>}
        description={`${SCOPE_LABEL[run.scope] ?? run.scope} · ${formatDateTime(run.checkedAt)}`}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Records checked" value={run.recordsChecked} hint="audit rows + payments" />
          <StatCard
            label="Mismatches"
            value={run.mismatches}
            hint={run.mismatches === 0 ? 'nothing disagrees' : 'see the detail below'}
            tone={run.mismatches > 0 ? 'danger' : 'default'}
          />
          <StatCard
            label="Chain head"
            value={`seq ${chain?.headSeq ?? '—'}`}
            hint={chain ? shortHash(chain.headHash, 10) : 'not available'}
          />
        </div>

        {verdict === 'tampered' ? (
          <div className="mt-4">
            <Alert>
              The recomputation does not match what is stored. This is a finding, not an error: treat the affected rows as untrusted and
              preserve them before anyone "fixes" the data.
            </Alert>
          </div>
        ) : null}

        {chain && chain.mismatches.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-20">Seq</th>
                  <th>Problem</th>
                  <th>Expected</th>
                  <th>Stored</th>
                </tr>
              </thead>
              <tbody>
                {chain.mismatches.slice(0, 20).map((mismatch) => (
                  <tr key={`${mismatch.seq}-${mismatch.reason}`}>
                    <td className="font-mono text-xs">{mismatch.seq}</td>
                    <td>
                      <Badge tone={mismatch.reason === 'hash_mismatch' ? 'danger' : 'warning'}>
                        {mismatch.reason === 'hash_mismatch' ? 'Row edited' : 'Chain link broken'}
                      </Badge>
                    </td>
                    <td className="font-mono text-[11px] break-all text-slate-500">{mismatch.expected}</td>
                    <td className="font-mono text-[11px] break-all text-slate-500">{mismatch.actual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {chain.mismatches.length > 20 ? (
              <p className="mt-2 text-xs text-slate-500">{chain.mismatches.length - 20} further mismatch(es) not shown.</p>
            ) : null}
          </div>
        ) : null}

        {loans.length > 0 ? (
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Per-loan payment state</h3>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th className="text-right">Payments</th>
                    <th className="text-right">Verified</th>
                    <th className="text-right">Anchored, unchecked</th>
                    <th className="text-right">Unanchored</th>
                    <th className="text-right">Broken</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {loans.map((line) => (
                    <tr key={line.id}>
                      <td className="font-mono text-xs">{line.ref}</td>
                      <td className="text-right">{line.summary.total}</td>
                      <td className="text-right">{line.summary.verified}</td>
                      <td className="text-right">{line.summary.anchoredUnchecked}</td>
                      <td className="text-right text-slate-500">{line.summary.unanchored}</td>
                      <td className={`text-right ${line.summary.broken > 0 ? 'font-semibold text-red-600' : ''}`}>
                        {line.summary.broken}
                      </td>
                      <td>
                        <Badge tone={line.ok ? 'success' : 'danger'}>{line.ok ? 'matches' : 'broken'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              "Unanchored" means the payment was never written to the ledger (the chain was off), so its hash proves it has not changed
              since it was recorded -- not that it was ever confirmed on-chain.
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
