import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { encryptField, nationalIdBlindIndex, phoneBlindIndex } from '../lib/crypto';
import { recordAudit } from '../modules/audit/audit.service';
import { pool, withTransaction } from './pool';

/**
 * Demo seed data.
 *
 * Every account uses the password from DEMO_SEED_PASSWORD (required).
 * The admin account is created here rather than through /auth/register
 * on purpose: the public API can only create borrowers and staff, so an
 * admin must be provisioned by an administrator.
 *
 * Safety guards:
 *  - Refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true.
 *  - Requires DEMO_SEED_PASSWORD to be set explicitly in the environment.
 */

const IS_PRODUCTION = config.NODE_ENV === 'production';
const ALLOW_DEMO_SEED = process.env.ALLOW_DEMO_SEED === 'true';
const DEMO_SEED_PASSWORD = process.env.DEMO_SEED_PASSWORD;

export const DEMO_PASSWORD = DEMO_SEED_PASSWORD ?? 'UNSET';

interface SeedPerson {
  email: string;
  fullName: string;
  role: 'borrower' | 'staff' | 'admin';
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

export const demoPeople: SeedPerson[] = [
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
    // Second borrower whose phone number collides with the first one -- the
    // fraud module should flag it as an identity inconsistency.
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
  {
    email: 'admin@smf.demo',
    fullName: 'Forensic Desk',
    role: 'admin',
  },
];

async function upsertPerson(person: SeedPerson, passwordHash: string): Promise<string> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [person.email]);
    if (existing.rowCount) {
      console.log(`[seed] ${person.email} already exists`);
      return existing.rows[0].id;
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
    return userId;
  });
}

export async function seed(): Promise<void> {
  if (IS_PRODUCTION && !ALLOW_DEMO_SEED) {
    throw new Error(
      '[seed] Refusing to seed demo accounts in production. ' +
        'Set ALLOW_DEMO_SEED=true to override — only do this for a live demo environment, ' +
        'and change or delete these accounts before using real borrower data.',
    );
  }

  if (!DEMO_SEED_PASSWORD) {
    throw new Error(
      '[seed] DEMO_SEED_PASSWORD is not set. ' +
        'Add it to your .env file (e.g. DEMO_SEED_PASSWORD=Passw0rd!demo) and re-run.',
    );
  }

  const passwordHash = await bcrypt.hash(DEMO_SEED_PASSWORD, config.BCRYPT_COST);
  for (const person of demoPeople) {
    await upsertPerson(person, passwordHash);
  }
  console.log(`\n[seed] demo password for every account: ${DEMO_SEED_PASSWORD}`);
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
