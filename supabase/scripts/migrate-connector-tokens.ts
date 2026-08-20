import postgres from "postgres";
import {
  migrateTenantConnectorTokens,
  type ConnectorMigrationTransaction,
} from "./connector-token-migration-core.ts";

const args = [...Deno.args];
const tenantAt = args.indexOf("--tenant");
const apply = args.includes("--apply");
const allowedLength = apply ? 3 : 2;
if (tenantAt !== 0 || !args[1] || args.length !== allowedLength || (apply && args[2] !== "--apply")) {
  console.error("usage: deno run --allow-env --allow-net migrate-connector-tokens.ts --tenant <uuid> [--apply]");
  Deno.exit(2);
}

const tenantId = args[1];
const databaseUrl = Deno.env.get("DATABASE_URL") ?? "";
const encodedKey = Deno.env.get("CONNECTOR_TOKEN_ENCRYPTION_KEY") ?? "";
if (!databaseUrl || !encodedKey) {
  console.error("connector_migration_configuration_missing");
  Deno.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, prepare: true, idle_timeout: 5, connect_timeout: 5 });
try {
  const result = await migrateTenantConnectorTokens({
    tenantId,
    encodedKey,
    apply,
    store: {
      async transaction<T>(operation: (transaction: ConnectorMigrationTransaction) => Promise<T>): Promise<T> {
        const result = await sql.begin(async (transactionSql) => {
          const transaction: ConnectorMigrationTransaction = {
          async lockLegacyRows(lockedTenant) {
            return await transactionSql`
              select id, tenant_id, provider, account_email, token_account_ref, refresh_token
              from public.connector_accounts
              where tenant_id = ${lockedTenant}::uuid and refresh_token is not null
              order by provider, id
              for update
            `;
          },
          async persistEncrypted(input) {
            const rows = await transactionSql`
              update public.connector_accounts
              set refresh_token_ciphertext = ${input.wire.ciphertext},
                  refresh_token_iv = ${input.wire.iv},
                  token_key_version = ${input.wire.keyVersion},
                  token_account_ref = ${input.accountRef},
                  refresh_token = null,
                  status = 'active',
                  last_error = null,
                  updated_at = clock_timestamp()
              where id = ${input.id}::uuid
                and tenant_id = ${input.tenantId}::uuid
                and provider = ${input.provider}
                and refresh_token = ${input.expectedPlaintext}
              returning id
            `;
            return rows.length === 1;
          },
          async readEncrypted(id) {
            const rows = await transactionSql`
              select refresh_token, refresh_token_ciphertext, refresh_token_iv,
                     token_key_version, token_account_ref, status
              from public.connector_accounts
              where id = ${id}::uuid
            `;
            return rows.length === 1 ? rows[0] : null;
          },
          };
          return operation(transaction);
        });
        return result as unknown as T;
      },
    },
  });
  console.log(JSON.stringify(result));
} catch {
  console.error("connector_migration_failed");
  Deno.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 });
}
