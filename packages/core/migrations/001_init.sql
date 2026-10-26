-- ABA Treatment Plan Assistant: initial schema.
-- Every tenant-owned table carries tenant_id and is protected by row-level
-- security. The application connects as aba_app (not the owner), and RLS is
-- FORCED so even owner-run queries are filtered. Session context is set per
-- transaction with set_config('app.tenant_id' | 'app.user_id' | 'app.role').

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'none') $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{"retention_days": 2555, "complex_case_model": false}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  cognito_sub text UNIQUE,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('super_admin', 'company_admin', 'clinical_director', 'bcba', 'read_only')),
  name text NOT NULL,
  credential text,
  npi text,
  -- local-mode auth only (production uses Cognito, these stay NULL)
  password_hash text,
  totp_secret text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin') = (tenant_id IS NULL))
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  dob date,
  gender text,
  medicaid_id text,
  payer text,
  diagnosis text,
  assigned_bcba_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discharged', 'archived')),
  auth_end_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_tenant_idx ON clients (tenant_id, assigned_bcba_id);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  current_version_id uuid,
  docx_s3_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  template_id uuid NOT NULL REFERENCES templates(id),
  version int NOT NULL,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  schema_json jsonb NOT NULL,
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  change_reason text,
  compliance_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
ALTER TABLE templates ADD CONSTRAINT templates_current_fk FOREIGN KEY (current_version_id) REFERENCES template_versions(id);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  template_version_id uuid NOT NULL REFERENCES template_versions(id),
  type text NOT NULL CHECK (type IN ('initial', 'reassessment')),
  period_start date,
  period_end date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'final')),
  final_date date,
  current_version int NOT NULL DEFAULT 0,
  complex_case boolean NOT NULL DEFAULT false,
  previous_plan_id uuid REFERENCES plans(id),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  generation_status text NOT NULL DEFAULT 'idle',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_client_idx ON plans (tenant_id, client_id);

CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  version int NOT NULL,
  content_json jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  change_summary text NOT NULL DEFAULT '',
  locked boolean NOT NULL DEFAULT false,
  UNIQUE (plan_id, version)
);

-- Finalized versions are immutable.
CREATE OR REPLACE FUNCTION plan_versions_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked AND coalesce(current_setting('app.retention', true), '') <> 'on' THEN
    RAISE EXCEPTION 'plan version % is finalized and locked', OLD.version;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_versions_lock_trg BEFORE UPDATE OR DELETE ON plan_versions FOR EACH ROW EXECUTE FUNCTION plan_versions_lock();

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  plan_id uuid REFERENCES plans(id),
  s3_key text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  pages int,
  uploaded_by uuid REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  extraction_status text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'uploaded', 'processing', 'done', 'failed', 'needs_ocr')),
  extraction_error text
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  file_id uuid REFERENCES files(id),
  page int,
  fact_text text NOT NULL,
  category text NOT NULL,
  value text,
  unit text,
  source_date date,
  confirmed_by_bcba boolean NOT NULL DEFAULT false,
  edited_by_bcba boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_plan_idx ON evidence (plan_id);

CREATE TABLE bcba_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  question_id text NOT NULL,
  answer_text text NOT NULL,
  input_mode text NOT NULL DEFAULT 'typed' CHECK (input_mode IN ('typed', 'voice')),
  is_follow_up boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bcba_answers_plan_idx ON bcba_answers (plan_id, question_id);

CREATE TABLE review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  field_id text,
  kind text NOT NULL CHECK (kind IN ('placeholder', 'conflict', 'low_input', 'unsupported', 'mismatch', 'carried_forward', 'needs_ocr')),
  detail text NOT NULL,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid REFERENCES plans(id),
  template_id uuid REFERENCES templates(id),
  channel text NOT NULL DEFAULT 'edit' CHECK (channel IN ('guided', 'edit', 'template')),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (plan_id IS NOT NULL OR template_id IS NOT NULL)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  ip text,
  user_agent text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_at_idx ON audit_log (tenant_id, at DESC);

CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();

CREATE TABLE ai_usage (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid REFERENCES plans(id),
  step text NOT NULL,
  model text NOT NULL,
  input_tokens int NOT NULL,
  output_tokens int NOT NULL,
  est_cost numeric(12, 6) NOT NULL,
  latency_ms int,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_tenant_at_idx ON ai_usage (tenant_id, at);

-- Logged, time-limited support access for the platform owner (spec: super admin).
CREATE TABLE support_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  granted_to uuid NOT NULL REFERENCES users(id),
  granted_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

---------------------------------------------------------------------------
-- Row-level security
---------------------------------------------------------------------------

-- Visible tenant rows: own tenant only. Super admins without a support grant see none.
CREATE OR REPLACE FUNCTION tenant_ok(t uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT t IS NOT NULL AND t = app_tenant() $$;

-- BCBAs see only assigned clients; everyone else in the tenant sees all.
CREATE OR REPLACE FUNCTION client_visible(c clients) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT tenant_ok(c.tenant_id) AND (app_role() <> 'bcba' OR c.assigned_bcba_id = app_user()) $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','templates','template_versions','plans','plan_versions','files','evidence','bcba_answers','review_items','chat_messages','ai_usage','jobs','support_grants','audit_log','users','tenants']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- tenants: own tenant; super admin may list all tenants (no client data in this table).
CREATE POLICY tenants_read ON tenants FOR SELECT USING (id = app_tenant() OR app_role() = 'super_admin');
CREATE POLICY tenants_write ON tenants FOR ALL USING (app_role() = 'super_admin' OR (id = app_tenant() AND app_role() = 'company_admin'))
  WITH CHECK (app_role() = 'super_admin' OR (id = app_tenant() AND app_role() = 'company_admin'));

-- users: same tenant; self; super admin manages accounts but not client data.
CREATE POLICY users_read ON users FOR SELECT USING (tenant_ok(tenant_id) OR id = app_user() OR app_role() = 'super_admin' OR app_role() = 'auth');
CREATE POLICY users_write ON users FOR ALL USING ((tenant_ok(tenant_id) AND app_role() = 'company_admin') OR app_role() = 'super_admin')
  WITH CHECK ((tenant_ok(tenant_id) AND app_role() = 'company_admin' AND role <> 'super_admin') OR app_role() = 'super_admin');

-- clients
CREATE POLICY clients_read ON clients FOR SELECT USING (client_visible(clients));
CREATE POLICY clients_insert ON clients FOR INSERT WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'clinical_director', 'bcba', 'system') AND (app_role() <> 'bcba' OR assigned_bcba_id = app_user()));
CREATE POLICY clients_update ON clients FOR UPDATE USING (client_visible(clients) AND app_role() IN ('company_admin', 'clinical_director', 'bcba', 'system'))
  WITH CHECK (tenant_ok(tenant_id) AND (app_role() <> 'bcba' OR assigned_bcba_id = app_user()));
CREATE POLICY clients_delete ON clients FOR DELETE USING (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'system'));

-- templates: all tenant users read; only company admins write.
CREATE POLICY templates_read ON templates FOR SELECT USING (tenant_ok(tenant_id));
CREATE POLICY templates_write ON templates FOR ALL USING (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'system')) WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'system'));
CREATE POLICY tv_read ON template_versions FOR SELECT USING (tenant_ok(tenant_id));
CREATE POLICY tv_write ON template_versions FOR ALL USING (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'system')) WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'system'));

-- plans: visible if the client is visible; read-only users see final plans only.
CREATE POLICY plans_read ON plans FOR SELECT USING (
  tenant_ok(tenant_id)
  AND EXISTS (SELECT 1 FROM clients c WHERE c.id = plans.client_id)
  AND (app_role() <> 'read_only' OR status = 'final'));
CREATE POLICY plans_write ON plans FOR ALL USING (
  tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'clinical_director', 'bcba', 'system')
  AND EXISTS (SELECT 1 FROM clients c WHERE c.id = plans.client_id))
  WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin', 'clinical_director', 'bcba', 'system')
  AND EXISTS (SELECT 1 FROM clients c WHERE c.id = plans.client_id));

-- Child tables of plans inherit the plan's visibility.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plan_versions','evidence','bcba_answers','review_items']
  LOOP
    EXECUTE format($f$CREATE POLICY %1$s_read ON %1$I FOR SELECT USING (tenant_ok(tenant_id) AND EXISTS (SELECT 1 FROM plans p WHERE p.id = %1$I.plan_id))$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_write ON %1$I FOR ALL USING (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM plans p WHERE p.id = %1$I.plan_id))
      WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM plans p WHERE p.id = %1$I.plan_id))$f$, t);
  END LOOP;
END $$;

CREATE POLICY files_read ON files FOR SELECT USING (tenant_ok(tenant_id) AND EXISTS (SELECT 1 FROM clients c WHERE c.id = files.client_id) AND app_role() <> 'read_only');
CREATE POLICY files_write ON files FOR ALL USING (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM clients c WHERE c.id = files.client_id))
  WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM clients c WHERE c.id = files.client_id));

CREATE POLICY chat_read ON chat_messages FOR SELECT USING (tenant_ok(tenant_id) AND (
  (plan_id IS NOT NULL AND EXISTS (SELECT 1 FROM plans p WHERE p.id = chat_messages.plan_id))
  OR (template_id IS NOT NULL AND app_role() IN ('company_admin', 'system'))));
CREATE POLICY chat_write ON chat_messages FOR INSERT WITH CHECK (tenant_ok(tenant_id) AND app_role() <> 'read_only' AND (
  (plan_id IS NOT NULL AND EXISTS (SELECT 1 FROM plans p WHERE p.id = chat_messages.plan_id))
  OR (template_id IS NOT NULL AND app_role() IN ('company_admin', 'system'))));

CREATE POLICY usage_read ON ai_usage FOR SELECT USING (tenant_ok(tenant_id) OR app_role() = 'super_admin');
CREATE POLICY usage_insert ON ai_usage FOR INSERT WITH CHECK (tenant_ok(tenant_id));

CREATE POLICY jobs_all ON jobs FOR ALL USING (tenant_ok(tenant_id)) WITH CHECK (tenant_ok(tenant_id));

CREATE POLICY grants_read ON support_grants FOR SELECT USING (app_role() = 'super_admin' OR (tenant_ok(tenant_id) AND app_role() = 'company_admin'));
CREATE POLICY grants_write ON support_grants FOR INSERT WITH CHECK (app_role() = 'super_admin');
CREATE POLICY grants_revoke ON support_grants FOR UPDATE USING (app_role() = 'super_admin' OR (tenant_ok(tenant_id) AND app_role() = 'company_admin'));

-- audit_log: anyone may append for their own tenant (or platform events); only admins read.
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (tenant_id IS NULL OR tenant_ok(tenant_id));
CREATE POLICY audit_read ON audit_log FOR SELECT USING ((tenant_ok(tenant_id) AND app_role() = 'company_admin') OR (app_role() = 'super_admin' AND tenant_id IS NULL));

-- Runtime role privileges (role itself is created by the bootstrap script / CDK custom resource).
GRANT USAGE ON SCHEMA public TO aba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aba_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM aba_app;
REVOKE DELETE, TRUNCATE ON plan_versions FROM aba_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aba_app;
