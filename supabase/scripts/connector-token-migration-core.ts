import {
  decryptConnectorToken,
  encryptConnectorToken,
  type ConnectorTokenWire,
} from "../functions/_shared/connector-crypto.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDER = /^[a-z][a-z0-9_]{0,63}$/;

export interface LegacyConnectorRow {
  id: string;
  tenant_id: string;
  provider: string;
  account_email: string | null;
  token_account_ref: string | null;
  refresh_token: string;
}

export interface ConnectorMigrationTransaction {
  lockLegacyRows(tenantId: string): Promise<LegacyConnectorRow[]>;
  persistEncrypted(input: {
    id: string;
    tenantId: string;
    provider: string;
    expectedPlaintext: string;
    accountRef: string;
    wire: ConnectorTokenWire;
  }): Promise<boolean>;
  readEncrypted(id: string): Promise<Record<string, unknown> | null>;
}

export interface ConnectorMigrationStore {
  transaction<T>(operation: (transaction: ConnectorMigrationTransaction) => Promise<T>): Promise<T>;
}

function accountReference(row: LegacyConnectorRow): string {
  const candidate = row.token_account_ref ?? row.account_email ?? `${row.provider}-primary`;
  if (!candidate || candidate.length > 320 || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error("connector_migration_account_ref_invalid");
  }
  return candidate;
}

export async function migrateTenantConnectorTokens(input: {
  tenantId: string;
  encodedKey: string;
  apply?: boolean;
  store: ConnectorMigrationStore;
  report?: (value: unknown) => void;
}) {
  if (!UUID.test(input.tenantId)) throw new Error("connector_migration_tenant_invalid");
  const apply = input.apply === true;
  const result = await input.store.transaction(async (transaction) => {
    const rows = await transaction.lockLegacyRows(input.tenantId);
    if (!Array.isArray(rows) || rows.some((row) => row.tenant_id !== input.tenantId
      || !UUID.test(row.tenant_id) || !PROVIDER.test(row.provider) || !row.id || !row.refresh_token)) {
      throw new Error("connector_migration_row_invalid");
    }
    if (!apply) return { tenant_id: input.tenantId, mode: "dry-run", eligible: rows.length, migrated: 0 } as const;
    let migrated = 0;
    for (const row of rows) {
      const accountRef = accountReference(row);
      const aad = { tenantId: row.tenant_id, provider: row.provider, accountRef, keyVersion: 1 };
      const wire = await encryptConnectorToken(row.refresh_token, aad, input.encodedKey);
      const beforeWrite = await decryptConnectorToken(wire, aad, { 1: input.encodedKey });
      if (beforeWrite !== row.refresh_token) throw new Error("connector_migration_prewrite_verification_failed");
      const updated = await transaction.persistEncrypted({
        id: row.id,
        tenantId: row.tenant_id,
        provider: row.provider,
        expectedPlaintext: row.refresh_token,
        accountRef,
        wire,
      });
      if (!updated) throw new Error("connector_migration_concurrent_change");
      const persisted = await transaction.readEncrypted(row.id);
      if (!persisted || persisted.refresh_token !== null
        || persisted.status !== "active"
        || persisted.token_account_ref !== accountRef) throw new Error("connector_migration_persisted_state_invalid");
      const verified = await decryptConnectorToken({
        ciphertext: String(persisted.refresh_token_ciphertext ?? ""),
        iv: String(persisted.refresh_token_iv ?? ""),
        keyVersion: Number(persisted.token_key_version),
      }, aad, { 1: input.encodedKey });
      if (verified !== row.refresh_token) throw new Error("connector_migration_postwrite_verification_failed");
      migrated += 1;
    }
    return { tenant_id: input.tenantId, mode: "apply", eligible: rows.length, migrated } as const;
  });
  input.report?.(result);
  return result;
}
