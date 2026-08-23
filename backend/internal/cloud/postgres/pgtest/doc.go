// Package pgtest provisions PostgreSQL databases for hosted control-plane
// tests. This file documents how to point it at an instance.
//
// # Running the PostgreSQL tests
//
// Tests that call New skip unless two variables are set:
//
//	AO_CLOUD_TEST_MIGRATION_DATABASE_URL   privileged migration role
//	AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE    restricted runtime login role
//	AO_CLOUD_TEST_RUNTIME_DATABASE_PASSWORD (optional)
//
// The migration role owns the schema and must be able to CREATE DATABASE,
// because each test provisions its own. That requirement is specific to the
// tests: a deployment's migration role never creates databases.
//
// # Starting a throwaway PostgreSQL
//
// Label the container so the orchestrator reaps it when the session ends:
//
//	docker run -d --rm \
//	  --name ao-cloud-test-pg-"$AO_SESSION_ID" \
//	  --label ao.session="$AO_SESSION_ID" \
//	  -e POSTGRES_PASSWORD=postgres \
//	  -p 55432:5432 \
//	  postgres:16-alpine
//
// Then create the migration role and its database, which the runtime role is
// deliberately not allowed to do:
//
//	psql "postgres://postgres:postgres@127.0.0.1:55432/postgres" <<'SQL'
//	CREATE ROLE ao_migrate LOGIN PASSWORD 'migrate' CREATEROLE CREATEDB;
//	CREATE DATABASE ao_cloud_test OWNER ao_migrate;
//	SQL
//
//	export AO_CLOUD_TEST_MIGRATION_DATABASE_URL='postgres://ao_migrate:migrate@127.0.0.1:55432/ao_cloud_test?sslmode=disable'
//	export AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE=ao_runtime
//	go test ./internal/cloud/postgres/...
//
// CREATEROLE is what lets the migration role mint the unprivileged ao_runtime
// login and the NOLOGIN ao_cloud_auth role the pre-authentication functions run
// as. The runtime role itself is created without it, and Open refuses to start
// on a runtime role that has it.
package pgtest
