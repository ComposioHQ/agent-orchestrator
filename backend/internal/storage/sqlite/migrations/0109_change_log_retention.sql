-- +goose NO TRANSACTION
-- +goose Up

-- Bound existing installations before VACUUM rewrites the file. Choosing the
-- (100000+1)th newest row keeps the newest 100000 actual events even when prior
-- session deletion left gaps in the AUTOINCREMENT sequence.
DELETE FROM change_log
WHERE seq <= COALESCE((
    SELECT seq
    FROM change_log
    ORDER BY seq DESC
    LIMIT 1 OFFSET 100000
), 0);

-- Existing databases default to auto_vacuum=NONE. Changing modes requires a
-- full VACUUM exactly once; later retention passes use incremental_vacuum so
-- they return only newly freed pages without rewriting the whole database.
PRAGMA auto_vacuum=INCREMENTAL;
VACUUM;

-- +goose Down

-- Retention deletes durable history and cannot be reversed. Keep incremental
-- auto-vacuum enabled on downgrade rather than forcing another full rewrite.
SELECT 1;
