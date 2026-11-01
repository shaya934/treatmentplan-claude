-- Graphs found in uploaded files. The cropped image lives in S3 (s3_key); the
-- BCBA chooses which ones appear in the exported plan (include_in_report).
CREATE TABLE figures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  file_id uuid REFERENCES files(id),
  page int NOT NULL,
  s3_key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  include_in_report boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX figures_plan_idx ON figures (plan_id);

ALTER TABLE figures ENABLE ROW LEVEL SECURITY;
ALTER TABLE figures FORCE ROW LEVEL SECURITY;

-- Same visibility as the other child tables of plans (evidence, answers, ...).
CREATE POLICY figures_read ON figures FOR SELECT USING (tenant_ok(tenant_id) AND EXISTS (SELECT 1 FROM plans p WHERE p.id = figures.plan_id));
CREATE POLICY figures_write ON figures FOR ALL
  USING (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM plans p WHERE p.id = figures.plan_id))
  WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM plans p WHERE p.id = figures.plan_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON figures TO aba_app;
