import { generate } from "otplib";

/** Local demo helper: prints the current TOTP code for a seeded secret. */
const secret = process.argv[2];
if (!secret) throw new Error("usage: pnpm totp <secret>");
console.log(await generate({ secret }));
