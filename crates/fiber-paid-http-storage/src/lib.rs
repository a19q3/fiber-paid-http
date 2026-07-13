use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use thiserror::Error;

pub const SQLITE_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "unsupported database schema {0}; create a new schema {SQLITE_SCHEMA_VERSION} database"
    )]
    IncompatibleSchema(i64),
    #[error("database schema v1 is not canonical: {0}")]
    InvalidSchema(String),
}

#[derive(Debug, Clone)]
pub struct ChallengeRecord {
    pub challenge: Value,
    pub charge_request: Value,
    pub resource_binding: Value,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone)]
pub struct RedemptionRecord {
    pub challenge_id: String,
    pub credential_hash: String,
    pub payment_hash: String,
    pub settlement: Value,
    pub consumed_at: String,
}

#[derive(Debug, Clone)]
pub struct DeliveryOutcome {
    pub challenge_id: String,
    pub credential_hash: String,
    pub payment_hash: String,
    pub receipt_reference: Option<String>,
    pub status: String,
    pub response_status: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub recorded_at: String,
}

pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let connection = Connection::open(path)?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let existing_tables: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if (version == 0 && existing_tables > 0)
            || (version != 0 && version != SQLITE_SCHEMA_VERSION)
        {
            return Err(StorageError::IncompatibleSchema(version));
        }
        connection.execute_batch(&format!(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS fiber_paid_http_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS challenges (
              id TEXT PRIMARY KEY,
              challenge TEXT NOT NULL,
              charge_request TEXT NOT NULL,
              resource_binding TEXT NOT NULL,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              consumed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS redemptions (
              challenge_id TEXT PRIMARY KEY,
              credential_hash TEXT NOT NULL UNIQUE,
              payment_hash TEXT NOT NULL UNIQUE,
              settlement TEXT NOT NULL,
              consumed_at TEXT NOT NULL,
              FOREIGN KEY(challenge_id) REFERENCES challenges(id)
            );
            CREATE TABLE IF NOT EXISTS receipts (
              reference TEXT PRIMARY KEY,
              challenge_id TEXT NOT NULL UNIQUE,
              receipt TEXT NOT NULL,
              FOREIGN KEY(challenge_id) REFERENCES challenges(id)
            );
            CREATE TABLE IF NOT EXISTS payment_observations (
              payment_hash TEXT PRIMARY KEY,
              observation TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS delivery_outcomes (
              challenge_id TEXT PRIMARY KEY,
              credential_hash TEXT NOT NULL,
              payment_hash TEXT NOT NULL,
              receipt_reference TEXT,
              status TEXT NOT NULL,
              response_status INTEGER,
              error_code TEXT,
              error_message TEXT,
              recorded_at TEXT NOT NULL,
              FOREIGN KEY(challenge_id) REFERENCES challenges(id)
            );
            PRAGMA user_version = {SQLITE_SCHEMA_VERSION};
            "
        ))?;
        connection.execute(
            "INSERT OR REPLACE INTO fiber_paid_http_meta (key, value) VALUES (?1, ?2)",
            params!["schema_version", SQLITE_SCHEMA_VERSION.to_string()],
        )?;
        assert_canonical_schema(&connection)?;
        Ok(Self { connection })
    }

    pub fn save_challenge(
        &self,
        challenge_id: &str,
        record: &ChallengeRecord,
    ) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT OR IGNORE INTO challenges
             (id, challenge, charge_request, resource_binding, created_at, expires_at, consumed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            params![
                challenge_id,
                serde_json::to_string(&record.challenge)?,
                serde_json::to_string(&record.charge_request)?,
                serde_json::to_string(&record.resource_binding)?,
                record.created_at,
                record.expires_at
            ],
        )?;
        Ok(())
    }

    pub fn get_challenge(
        &self,
        challenge_id: &str,
    ) -> Result<Option<ChallengeRecord>, StorageError> {
        self.connection
            .query_row(
                "SELECT challenge, charge_request, resource_binding, created_at, expires_at
                 FROM challenges WHERE id = ?1",
                params![challenge_id],
                |row| {
                    let challenge: String = row.get(0)?;
                    let charge_request: String = row.get(1)?;
                    let resource_binding: String = row.get(2)?;
                    Ok((
                        challenge,
                        charge_request,
                        resource_binding,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
            .map(
                |(challenge, charge_request, resource_binding, created_at, expires_at)| {
                    Ok(ChallengeRecord {
                        challenge: serde_json::from_str(&challenge)?,
                        charge_request: serde_json::from_str(&charge_request)?,
                        resource_binding: serde_json::from_str(&resource_binding)?,
                        created_at,
                        expires_at,
                    })
                },
            )
            .transpose()
    }

    pub fn consume_redemption(&mut self, record: &RedemptionRecord) -> Result<bool, StorageError> {
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL",
            params![record.challenge_id, record.consumed_at],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return Ok(false);
        }
        let inserted = transaction.execute(
            "INSERT INTO redemptions
             (challenge_id, credential_hash, payment_hash, settlement, consumed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                record.challenge_id,
                record.credential_hash,
                record.payment_hash,
                serde_json::to_string(&record.settlement)?,
                record.consumed_at
            ],
        );
        if inserted.is_err() {
            transaction.rollback()?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO delivery_outcomes
             (challenge_id, credential_hash, payment_hash, status, recorded_at)
             VALUES (?1, ?2, ?3, 'pending', ?4)",
            params![
                record.challenge_id,
                record.credential_hash,
                record.payment_hash,
                record.consumed_at
            ],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn get_redemption(
        &self,
        challenge_id: &str,
    ) -> Result<Option<RedemptionRecord>, StorageError> {
        self.connection
            .query_row(
                "SELECT credential_hash, payment_hash, settlement, consumed_at
                 FROM redemptions WHERE challenge_id = ?1",
                params![challenge_id],
                |row| {
                    let settlement: String = row.get(2)?;
                    Ok((row.get(0)?, row.get(1)?, settlement, row.get(3)?))
                },
            )
            .optional()?
            .map(|(credential_hash, payment_hash, settlement, consumed_at)| {
                Ok(RedemptionRecord {
                    challenge_id: challenge_id.to_string(),
                    credential_hash,
                    payment_hash,
                    settlement: serde_json::from_str(&settlement)?,
                    consumed_at,
                })
            })
            .transpose()
    }

    pub fn save_receipt(&self, receipt: &Value) -> Result<(), StorageError> {
        let reference = string_field(receipt, "reference")?;
        let challenge_id = string_field(receipt, "challengeId")?;
        self.connection.execute(
            "INSERT OR IGNORE INTO receipts (reference, challenge_id, receipt) VALUES (?1, ?2, ?3)",
            params![reference, challenge_id, serde_json::to_string(receipt)?],
        )?;
        Ok(())
    }

    pub fn get_receipt(&self, reference: &str) -> Result<Option<Value>, StorageError> {
        self.connection
            .query_row(
                "SELECT receipt FROM receipts WHERE reference = ?1",
                params![reference],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|raw| Ok(serde_json::from_str(&raw)?))
            .transpose()
    }

    pub fn save_delivery_outcome(&self, outcome: &DeliveryOutcome) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT OR REPLACE INTO delivery_outcomes
             (challenge_id, credential_hash, payment_hash, receipt_reference, status,
              response_status, error_code, error_message, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                outcome.challenge_id,
                outcome.credential_hash,
                outcome.payment_hash,
                outcome.receipt_reference,
                outcome.status,
                outcome.response_status,
                outcome.error_code,
                outcome.error_message,
                outcome.recorded_at
            ],
        )?;
        Ok(())
    }

    pub fn readiness(&self) -> Result<bool, StorageError> {
        let schema_version: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let foreign_keys: i64 = self
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
        let integrity: String = self
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(schema_version == SQLITE_SCHEMA_VERSION && foreign_keys == 1 && integrity == "ok")
    }
}

const CANONICAL_SQLITE_SCHEMA: &[(&str, &[&str])] = &[
    (
        "challenges",
        &[
            "id",
            "challenge",
            "charge_request",
            "resource_binding",
            "created_at",
            "expires_at",
            "consumed_at",
        ],
    ),
    (
        "delivery_outcomes",
        &[
            "challenge_id",
            "credential_hash",
            "payment_hash",
            "receipt_reference",
            "status",
            "response_status",
            "error_code",
            "error_message",
            "recorded_at",
        ],
    ),
    ("fiber_paid_http_meta", &["key", "value"]),
    (
        "payment_observations",
        &["payment_hash", "observation", "updated_at"],
    ),
    ("receipts", &["reference", "challenge_id", "receipt"]),
    (
        "redemptions",
        &[
            "challenge_id",
            "credential_hash",
            "payment_hash",
            "settlement",
            "consumed_at",
        ],
    ),
];

fn assert_canonical_schema(connection: &Connection) -> Result<(), StorageError> {
    let mut tables_statement = connection.prepare(
        "SELECT name FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let actual_tables = tables_statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let expected_tables = CANONICAL_SQLITE_SCHEMA
        .iter()
        .map(|(table, _)| (*table).to_string())
        .collect::<Vec<_>>();
    if actual_tables != expected_tables {
        return Err(StorageError::InvalidSchema(
            "table set does not match".to_string(),
        ));
    }

    for (table, expected_columns) in CANONICAL_SQLITE_SCHEMA {
        let mut columns_statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let actual_columns = columns_statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        let expected_columns = expected_columns
            .iter()
            .map(|column| (*column).to_string())
            .collect::<Vec<_>>();
        if actual_columns != expected_columns {
            return Err(StorageError::InvalidSchema(format!(
                "table {table} columns do not match"
            )));
        }
    }
    Ok(())
}

fn string_field<'a>(value: &'a Value, field: &'static str) -> Result<&'a str, StorageError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("missing {field}"),
            ))
        })
        .map_err(StorageError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn consumes_redemption_atomically_once() {
        let dir = tempdir().unwrap();
        let mut store = SqliteStore::open(dir.path().join("store.sqlite")).unwrap();
        store
            .save_challenge(
                "challenge",
                &ChallengeRecord {
                    challenge: json!({"id":"challenge"}),
                    charge_request: json!({"amount":"1"}),
                    resource_binding: json!({"method":"GET","url":"https://example.com"}),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    expires_at: "2030-01-01T00:00:00Z".to_string(),
                },
            )
            .unwrap();
        let redemption = RedemptionRecord {
            challenge_id: "challenge".to_string(),
            credential_hash: "credential".to_string(),
            payment_hash: format!("0x{}", "ab".repeat(32)),
            settlement: json!({"status":"settled"}),
            consumed_at: "2026-01-01T00:00:01Z".to_string(),
        };
        assert!(store.consume_redemption(&redemption).unwrap());
        assert!(!store.consume_redemption(&redemption).unwrap());
        assert!(store.get_redemption("challenge").unwrap().is_some());
    }

    #[test]
    fn refuses_unversioned_database_with_application_tables() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unknown.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("CREATE TABLE unknown_data (id TEXT PRIMARY KEY)", [])
            .unwrap();
        drop(connection);

        assert!(matches!(
            SqliteStore::open(&path),
            Err(StorageError::IncompatibleSchema(0))
        ));
    }

    #[test]
    fn refuses_version_one_database_with_noncanonical_tables() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("invalid-v1.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("CREATE TABLE challenges (id TEXT PRIMARY KEY)", [])
            .unwrap();
        connection.execute_batch("PRAGMA user_version = 1").unwrap();
        drop(connection);

        assert!(matches!(
            SqliteStore::open(&path),
            Err(StorageError::InvalidSchema(_))
        ));
    }
}
