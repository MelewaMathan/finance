import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { queryOne, withTransaction } from '../../db/pool';
import { recordAudit } from '../audit/audit.service';

export interface InstitutionLoanSettings {
  interestRateBps: number;
  minPrincipalCents: number;
  maxPrincipalCents: number;
  maxInstallments: number;
  allowedFrequencies: Array<'daily' | 'weekly' | 'monthly'>;
  institutionName: string;
}

interface SettingsRow {
  interest_rate_bps: number;
  min_principal_cents: number;
  max_principal_cents: number;
  max_installments: number;
  allowed_frequencies: Array<'daily' | 'weekly' | 'monthly'>;
  institution_name: string;
}

function toSettings(row: SettingsRow): InstitutionLoanSettings {
  return {
    interestRateBps: row.interest_rate_bps,
    minPrincipalCents: Number(row.min_principal_cents),
    maxPrincipalCents: Number(row.max_principal_cents),
    maxInstallments: row.max_installments,
    allowedFrequencies: row.allowed_frequencies,
    institutionName: row.institution_name,
  };
}

const SETTINGS_SELECT = `
  SELECT interest_rate_bps, min_principal_cents, max_principal_cents,
         max_installments, allowed_frequencies, institution_name
    FROM institution_loan_settings
   WHERE id = true`;

export async function getInstitutionLoanSettings(): Promise<InstitutionLoanSettings> {
  const row = await queryOne<SettingsRow>(SETTINGS_SELECT);
  if (!row) throw new Error('Institution loan settings have not been initialized');
  return toSettings(row);
}

export async function updateInstitutionLoanSettings(
  actorId: string,
  settings: InstitutionLoanSettings,
  req: Request,
): Promise<InstitutionLoanSettings> {
  return withTransaction(async (client: PoolClient) => {
    const currentRow = await client.query<SettingsRow>(`${SETTINGS_SELECT} FOR UPDATE`);
    const current = currentRow.rows[0];
    if (!current) throw new Error('Institution loan settings have not been initialized');
    const previous = toSettings(current);
    const updated = await client.query<SettingsRow>(
      `UPDATE institution_loan_settings
          SET interest_rate_bps = $1,
              min_principal_cents = $2,
              max_principal_cents = $3,
              max_installments = $4,
              allowed_frequencies = $5,
              institution_name = $6,
              updated_by = $7
        WHERE id = true
        RETURNING interest_rate_bps, min_principal_cents, max_principal_cents,
                  max_installments, allowed_frequencies, institution_name`,
      [
        settings.interestRateBps,
        settings.minPrincipalCents,
        settings.maxPrincipalCents,
        settings.maxInstallments,
        settings.allowedFrequencies,
        settings.institutionName.trim(),
        actorId,
      ],
    );
    const next = toSettings(updated.rows[0]);

    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await recordAudit(
        {
          actorUserId: actorId,
          actorRole: 'admin',
          action: 'institution.loan_settings_updated',
          entityType: 'institution_loan_settings',
          entityId: 'true',
          detail: { oldValue: previous, newValue: next },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          requestId: req.requestId ?? null,
        },
        client,
      );
    }

    return next;
  });
}
