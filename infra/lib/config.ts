/** Per-environment settings. Dev holds synthetic data only; prod is defined but not deployed until the HIPAA review. */
export interface EnvConfig {
  name: "dev" | "prod";
  account?: string;
  region: "us-east-1";
  domainName: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  multiAz: boolean;
  natGateways: number;
  dbInstanceClass: string;
  webDesiredCount: number;
  workerDesiredCount: number;
  retainData: boolean;
  alarmEmail: string;
  monthlyBudgetUsd: number;
  /** Organization-level services (GuardDuty, Security Hub, Config) are enabled once per account. */
  enableAccountSecurityServices: boolean;
}

export function envConfig(name: string, ctx: (k: string) => unknown): EnvConfig {
  const o = (ctx(`aba:${name}`) ?? {}) as Partial<EnvConfig>;
  const base: EnvConfig =
    name === "prod"
      ? { name: "prod", region: "us-east-1", domainName: "app.REPLACE-ME.example", multiAz: true, natGateways: 2, dbInstanceClass: "t4g.medium", webDesiredCount: 2, workerDesiredCount: 2, retainData: true, alarmEmail: "REPLACE-ME@example.com", monthlyBudgetUsd: 1500, enableAccountSecurityServices: true }
      : { name: "dev", region: "us-east-1", domainName: "dev.REPLACE-ME.example", multiAz: false, natGateways: 1, dbInstanceClass: "t4g.small", webDesiredCount: 1, workerDesiredCount: 1, retainData: false, alarmEmail: "REPLACE-ME@example.com", monthlyBudgetUsd: 300, enableAccountSecurityServices: true };
  if (name !== "dev" && name !== "prod") throw new Error(`Unknown env ${name}`);
  return { ...base, ...o, name: base.name, region: "us-east-1" };
}
