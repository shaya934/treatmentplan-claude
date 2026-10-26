import { migrate } from "@aba/core/db";

const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://aba_owner:aba_owner_local@127.0.0.1:5432/aba";
await migrate(url);
console.log("migrations applied");
