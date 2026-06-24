use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
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

#[derive(Debug, Default)]
pub struct MemoryStore {
    used: HashSet<String>,
    values: HashMap<String, Value>,
}

impl ReplayStore for MemoryStore {
    fn mark_used(&mut self, key: &str, value: &Value) -> Result<bool, StorageError> {
        if self.used.contains(key) {
            return Ok(false);
        }
        self.used.insert(key.to_string());
        self.values.insert(key.to_string(), value.clone());
        Ok(true)
    }

    fn was_used(&self, key: &str) -> Result<bool, StorageError> {
        Ok(self.used.contains(key))
    }
}

pub struct SqliteStore {
    connection: Connection,
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS credential_uses (
              hash TEXT PRIMARY KEY,
              credential TEXT NOT NULL,
              used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS receipts (
              id TEXT PRIMARY KEY,
              receipt TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self { connection })
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
