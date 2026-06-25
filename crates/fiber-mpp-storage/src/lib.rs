use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub trait ReplayStore {
    fn mark_used(&mut self, key: &str, value: &Value) -> Result<bool, StorageError>;
    fn was_used(&self, key: &str) -> Result<bool, StorageError>;
}

#[derive(Debug, Clone)]
pub struct ChallengeRecord {
    pub challenge: Value,
    pub signature: String,
    pub resource_hash: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone)]
pub struct DeliveryOutcome {
    pub receipt_id: String,
    pub challenge_id: String,
    pub credential_hash: String,
    pub status: String,
    pub response_status: i64,
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
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS challenges (
              id TEXT PRIMARY KEY,
              challenge TEXT NOT NULL,
              signature TEXT NOT NULL,
              resource_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              used_at TEXT
            );
            CREATE TABLE IF NOT EXISTS credential_uses (
              hash TEXT PRIMARY KEY,
              credential TEXT NOT NULL,
              used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS receipts (
              id TEXT PRIMARY KEY,
              receipt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS delivery_outcomes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              receipt_id TEXT NOT NULL,
              challenge_id TEXT NOT NULL,
              credential_hash TEXT NOT NULL,
              status TEXT NOT NULL,
              response_status INTEGER NOT NULL,
              error_code TEXT,
              error_message TEXT,
              recorded_at TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self { connection })
    }

    pub fn save_challenge(&self, challenge_id: &str, record: &ChallengeRecord) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT OR REPLACE INTO challenges (id, challenge, signature, resource_hash, created_at, expires_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT used_at FROM challenges WHERE id = ?1))",
            params![
                challenge_id,
                serde_json::to_string(&record.challenge)?,
                record.signature,
                record.resource_hash,
                record.created_at,
                record.expires_at
            ],
        )?;
        Ok(())
    }

    pub fn get_challenge(&self, challenge_id: &str) -> Result<Option<ChallengeRecord>, StorageError> {
        let mut statement = self
            .connection
            .prepare("SELECT challenge, signature, resource_hash, created_at, expires_at FROM challenges WHERE id = ?1")?;
        let mut rows = statement.query(params![challenge_id])?;
        if let Some(row) = rows.next()? {
            let challenge: String = row.get(0)?;
            return Ok(Some(ChallengeRecord {
                challenge: serde_json::from_str(&challenge)?,
                signature: row.get(1)?,
                resource_hash: row.get(2)?,
                created_at: row.get(3)?,
                expires_at: row.get(4)?,
            }));
        }
        Ok(None)
    }

    pub fn mark_challenge_used(&self, challenge_id: &str, used_at: &str) -> Result<bool, StorageError> {
        let changed = self
            .connection
            .execute("UPDATE challenges SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL", params![challenge_id, used_at])?;
        Ok(changed == 1)
    }

    pub fn save_receipt(&self, receipt_id: &str, receipt: &Value) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT OR REPLACE INTO receipts (id, receipt) VALUES (?1, ?2)",
            params![receipt_id, serde_json::to_string(receipt)?],
        )?;
        Ok(())
    }

    pub fn get_receipt(&self, receipt_id: &str) -> Result<Option<Value>, StorageError> {
        let mut statement = self.connection.prepare("SELECT receipt FROM receipts WHERE id = ?1")?;
        let mut rows = statement.query(params![receipt_id])?;
        if let Some(row) = rows.next()? {
            let raw: String = row.get(0)?;
            return Ok(Some(serde_json::from_str(&raw)?));
        }
        Ok(None)
    }

    pub fn save_delivery_outcome(&self, outcome: &DeliveryOutcome) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO delivery_outcomes
             (receipt_id, challenge_id, credential_hash, status, response_status, error_code, error_message, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                outcome.receipt_id,
                outcome.challenge_id,
                outcome.credential_hash,
                outcome.status,
                outcome.response_status,
                outcome.error_code,
                outcome.error_message,
                outcome.recorded_at
            ],
        )?;
        Ok(())
    }
}

impl ReplayStore for SqliteStore {
    fn mark_used(&mut self, key: &str, value: &Value) -> Result<bool, StorageError> {
        let result = self
            .connection
            .execute("INSERT INTO credential_uses (hash, credential) VALUES (?1, ?2)", params![key, serde_json::to_string(value)?]);
        match result {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::ConstraintViolation => Ok(false),
            Err(error) => Err(StorageError::Sqlite(error)),
        }
    }

    fn was_used(&self, key: &str) -> Result<bool, StorageError> {
        let count: i64 =
            self.connection.query_row("SELECT COUNT(*) FROM credential_uses WHERE hash = ?1", params![key], |row| row.get(0))?;
        Ok(count > 0)
    }
}
