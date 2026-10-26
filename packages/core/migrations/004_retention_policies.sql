-- Retention / deletion-on-request support. Deleting plan history is allowed only
-- for the 'system' role inside a transaction that set app.retention = 'on'.
CREATE OR REPLACE FUNCTION retention_on() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_role() = 'system' AND coalesce(current_setting('app.retention', true), '') = 'on' $$;

GRANT DELETE ON plan_versions TO aba_app;

DROP POLICY plan_versions_write ON plan_versions;
CREATE POLICY plan_versions_insert ON plan_versions FOR INSERT
  WITH CHECK (tenant_ok(tenant_id) AND app_role() IN ('company_admin','clinical_director','bcba','system') AND EXISTS (SELECT 1 FROM plans p WHERE p.id = plan_versions.plan_id));
CREATE POLICY plan_versions_delete ON plan_versions FOR DELETE USING (tenant_ok(tenant_id) AND retention_on());

CREATE POLICY chat_delete ON chat_messages FOR DELETE USING (tenant_ok(tenant_id) AND retention_on());
CREATE POLICY usage_update ON ai_usage FOR UPDATE USING (tenant_ok(tenant_id) AND retention_on()) WITH CHECK (tenant_ok(tenant_id));
