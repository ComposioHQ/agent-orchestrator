package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// grantSCMRuntimeRole gives the restricted runtime role access to the SCM
// credential tables and to the SECURITY DEFINER functions that back webhook
// ingest and install-link completion. Those functions are owned by the
// narrowly privileged ao_cloud_scm role, so the grant is issued while assuming
// that role rather than by widening the migration or runtime role.
func grantSCMRuntimeRole(ctx context.Context, conn *pgx.Conn, runtimeRole string) error {
	role := pgx.Identifier{runtimeRole}.Sanitize()
	if _, err := conn.Exec(
		ctx,
		"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE"+
			" public.ao_scm_installations, public.ao_scm_repositories,"+
			" public.ao_scm_install_states, public.ao_scm_token_grants,"+
			" public.ao_scm_webhook_deliveries TO "+role,
	); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, `SET ROLE ao_cloud_scm`); err != nil {
		return err
	}
	if _, err := conn.Exec(
		ctx,
		"GRANT EXECUTE ON FUNCTION"+
			" public.ao_scm_consume_install_state(bytea),"+
			" public.ao_scm_record_webhook_delivery(text, text, text, bigint),"+
			" public.ao_scm_prune_webhook_deliveries(interval),"+
			" public.ao_scm_installation_context(text, bigint),"+
			" public.ao_scm_set_installation_status(text, bigint, text),"+
			" public.ao_scm_webhook_upsert_repository(text, bigint, bigint, text, boolean),"+
			" public.ao_scm_webhook_remove_repository(text, bigint, bigint)"+
			" TO "+role,
	); err != nil {
		_, _ = conn.Exec(ctx, `RESET ROLE`)
		return err
	}
	_, err := conn.Exec(ctx, `RESET ROLE`)
	return err
}
