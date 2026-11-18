import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { encryptField, nationalIdBlindIndex, phoneBlindIndex } from '../lib/crypto';
import { recordAudit } from '../modules/audit/audit.service';
import { pool, withTransaction } from './pool';

/**
 * Seed data.
 *
 * Section A — first admin account (always runs, idempotent).
 *   Email:    SEED_ADMIN_EMAIL    (default: admin@smf.com  — dev/test only)
 *   Password: SEED_ADMIN_PASSWORD (default: ADMINadmin123  — dev/test only)
 *   In production both env vars MUST be set explicitly; the defaults are
 *   refused.  must_change_password is set to true so the default password
 *   is replaced before the account is used for real.
 *
 * Section B — demo accounts (borrowers + staff).
 *   Only seeded when ALLOW_DEMO_SEED=true (never in production by default).
 *   Requires DEMO_SEED_PASSWORD to be set.
 *
 * Safety rules:
 *  - Running the seed again never resets an existing account's password.
 *  - Passwords are never logged or returned in any response.
 *  - Every creation is written to the audit chain.
 */

const IS_PRODUCTION = config.NODE_ENV === 'production';
const ALLOW_DEMO_SEED = process.env.ALLOW_DEMO_SEED === 'true';
const DEMO_SEED_PASSWORD = process.env.DEMO_SEED_PASSWORD;

// Admin seed credentials.
const DEFAULT_ADMIN_EMAIL = 'admin@smf.com';
const DEFAULT_ADMIN_PASSWORD = 'ADMINadmin123';

const SEED_ADMIN_EMAIL: string = (() => {
  if (config.SEED_ADMIN_EMAIL) return config.SEED_ADMIN_EMAIL;
  if (IS_PRODUCTION) throw new Error('[seed] SEED_ADMIN_EMAIL must be set in production');
  return DEFAULT_ADMIN_EMAIL;
})();

const SEED_ADMIN_PASSWORD_VALUE: string = (() => {
  if (config.SEED_ADMIN_PASSWORD) return config.SEED_ADMIN_PASSWORD;
  if (IS_PRODUCTION) throw new Error('[seed] SEED_ADMIN_PASSWORD must be set in production');
  return DEFAULT_ADMIN_PASSWORD;
})();

// ---------------------------------------------------------------------------
// Demo people (borrowers + staff only — no admin in this list)
// ---------------------------------------------------------------------------
interface DemoPerson {
  email: string;
  fullName: string;
  role: 'borrower' | 'staff';
  staffId?: string;
  profile?: {
    nationalId?: string;
    phone?: string;
    dateOfBirth?: string;
    address?: string;
    occupation?: string;
    monthlyIncomeCents?: number;
  };
}

export const demoPeople: DemoPerson[] = [
  {
    email: 'staff@smf.demo',
    fullName: 'Amani Kariuki',
    role: 'staff',
    staffId: 'SMF-STAFF-001',
  },
  {
    email: 'borrower@smf.demo',
    fullName: 'Grace Wanjiku',
    role: 'borrower',
    profile: {
      nationalId: '23456789',
      phone: '0712345678',
      dateOfBirth: '1994-04-18',
      address: 'Kawangware, Nairobi',
      occupation: 'Tailor',
      monthlyIncomeCents: 4200000,
    },
  },
  {
    email: 'borrower2@smf.demo',
    fullName: 'Peter Otieno',
    role: 'borrower',
    profile: {
      nationalId: '34567890',
      phone: '0712345678',
      dateOfBirth: '1989-11-02',
      address: 'Kibera, Nairobi',
      occupation: 'Boda rider',
      monthlyIncomeCents: 3000000,
    },
  },
];

// ---------------------------------------------------------------------------
// Admin seeding — always idempotent, never resets passwords
// ---------------------------------------------------------------------------
async function seedAdmin(): Promise<void> {
  const email = SEED_ADMIN_EMAIL.trim().toLowerCase();

  const existing = await pool.query<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE email = $1',
    [email],
  );
  if (existing.rowCount) {
    if (existing.rows[0].role !== 'admin') {
      throw new Error(`[seed] SEED_ADMIN_EMAIL ${email} is already assigned to a non-admin account`);
    }
    console.log(`[seed] admin ${email} already exists — skipping`);
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD_VALUE, config.BCRYPT_COST);

  await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, full_name, status, must_change_password)
       VALUES ($1, $2, 'admin', 'Platform Admin', 'active', true)
       RETURNING id`,
      [email, passwordHash],
    );
    const userId = inserted.rows[0].id;

    await recordAudit(
      {
        actorUserId: userId,
        actorRole: 'admin',
        action: 'seed.admin_created',
        entityType: 'user',
        entityId: userId,
        detail: { email, note: 'First admin seeded' },
        ip: null,
        userAgent: 'seed-script',
        requestId: null,
      },
      client,
    );
  });

  console.log(`[seed] created admin ${email} (must_change_password = true)`);
}

// ---------------------------------------------------------------------------
// Demo account seeding
// ---------------------------------------------------------------------------
async function upsertDemoPerson(person: DemoPerson, passwordHash: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [person.email]);
    if (existing.rowCount) {
      console.log(`[seed] ${person.email} already exists`);
      return;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, full_name, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [person.email, passwordHash, person.role, person.fullName],
    );
    const userId = inserted.rows[0].id;

    if (person.role === 'staff') {
      await client.query('INSERT INTO lender_profiles (user_id, staff_id) VALUES ($1, $2)', [
        userId,
        person.staffId ?? null,
      ]);
    }

    if (person.role === 'borrower') {
      const p = person.profile ?? {};
      await client.query(
        `INSERT INTO borrower_profiles
           (user_id, national_id_enc, national_id_bi, phone_enc, phone_bi,
            date_of_birth_enc, address_enc, occupation, monthly_income_cents, consent_flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId,
          p.nationalId ? encryptField(p.nationalId) : null,
          p.nationalId ? nationalIdBlindIndex(p.nationalId) : null,
          p.phone ? encryptField(p.phone) : null,
          p.phone ? phoneBlindIndex(p.phone) : null,
          p.dateOfBirth ? encryptField(p.dateOfBirth) : null,
          p.address ? encryptField(p.address) : null,
          p.occupation ?? null,
          p.monthlyIncomeCents ?? null,
          JSON.stringify({ dataProcessing: true, creditCheck: true }),
        ],
      );
    }

    await recordAudit(
      {
        actorUserId: userId,
        actorRole: person.role,
        action: 'seed.user_created',
        entityType: 'user',
        entityId: userId,
        detail: { email: person.email, role: person.role },
        ip: null,
        userAgent: 'seed-script',
        requestId: null,
      },
      client,
    );

    console.log(`[seed] created ${person.role} ${person.email}`);
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function seed(): Promise<void> {
  // Always seed the first admin.
  await seedAdmin();

  // Demo accounts are optional and refused in production unless explicitly
  // allowed.
  if (!ALLOW_DEMO_SEED) {
    if (IS_PRODUCTION) {
      console.log('[seed] Demo accounts skipped (production). Set ALLOW_DEMO_SEED=true to include them.');
    } else {
      console.log('[seed] Demo accounts skipped. Set ALLOW_DEMO_SEED=true to include them.');
    }
    return;
  }

  if (!DEMO_SEED_PASSWORD) {
    throw new Error(
      '[seed] DEMO_SEED_PASSWORD is not set. ' +
        'Add it to your .env file (e.g. DEMO_SEED_PASSWORD=Passw0rd!demo) and re-run.',
    );
  }

  const passwordHash = await bcrypt.hash(DEMO_SEED_PASSWORD, config.BCRYPT_COST);
  for (const person of demoPeople) {
    await upsertDemoPerson(person, passwordHash);
  }
  console.log('\n[seed] demo accounts created or already present');
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('[seed] failed:', error);
      await pool.end();
      process.exit(1);
    });
}
