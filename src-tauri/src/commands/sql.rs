use crate::types::AppState;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, File};
use std::path::Path;
use std::time::Instant;

const DEFAULT_MAX_ROWS: usize = 500;

#[derive(Serialize)]
pub struct SqlTableInfo {
    pub name: String,
}

#[derive(Serialize)]
pub struct SqlColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    pub primary_key: bool,
}

#[derive(Serialize)]
pub struct SqlTableSchema {
    pub columns: Vec<SqlColumnInfo>,
    pub indexes: Vec<String>,
    pub foreign_keys: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SqlQueryResponse {
    pub operation: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub truncated: bool,
    pub execution_time_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_rows: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct SqlQueryOptions {
    pub allow_write: bool,
    pub allow_ddl: bool,
    pub max_rows: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct SqlExportOptions {
    pub format: Option<String>,
    pub allow_write: bool,
    pub allow_ddl: bool,
}

#[derive(Serialize)]
pub struct SqlExportResponse {
    pub path: String,
    pub rows_written: usize,
}

#[derive(Debug, Serialize)]
struct QueryResults {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    total_rows: usize,
    truncated: bool,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum SqlOperation {
    Read,
    Write,
    Ddl,
    Dangerous,
}

#[tauri::command]
pub fn sql_list_tables(state: tauri::State<AppState>) -> Result<Vec<SqlTableInfo>, String> {
    let db = state
        .biovault_db
        .lock()
        .map_err(|_| "Failed to lock database")?;
    let mut stmt = db
        .conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| format!("Failed to prepare table list query: {}", e))?;

    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read table rows: {}", e))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| format!("Failed to collect table names: {}", e))?;

    Ok(names
        .into_iter()
        .map(|name| SqlTableInfo { name })
        .collect())
}

#[tauri::command]
pub fn sql_get_table_schema(
    state: tauri::State<AppState>,
    table: String,
) -> Result<SqlTableSchema, String> {
    let db = state
        .biovault_db
        .lock()
        .map_err(|_| "Failed to lock database")?;
    get_table_schema(&db.conn, &table).map_err(|e| format!("Failed to load schema: {}", e))
}

#[tauri::command]
pub fn sql_run_query(
    state: tauri::State<AppState>,
    query: String,
    options: Option<SqlQueryOptions>,
) -> Result<SqlQueryResponse, String> {
    let sanitized_query = sanitize_query(&query)?;
    let opts = options.unwrap_or_default();

    let operation = detect_sql_operation(&sanitized_query);
    ensure_operation_allowed(operation, opts.allow_write, opts.allow_ddl)?;

    if has_sql_injection_risk(&sanitized_query) {
        return Err("Potential SQL injection detected. Please review your query.".into());
    }

    let db = state
        .biovault_db
        .lock()
        .map_err(|_| "Failed to lock database")?;
    let start = Instant::now();

    let response = match operation {
        SqlOperation::Read => {
            let max_rows = opts.max_rows.unwrap_or(DEFAULT_MAX_ROWS);
            let results = execute_query(&db.conn, &sanitized_query, max_rows)
                .map_err(|e| format!("Failed to execute query: {}", e))?;

            SqlQueryResponse {
                operation: "read".to_string(),
                headers: results.headers,
                rows: results.rows,
                total_rows: results.total_rows,
                truncated: results.truncated,
                execution_time_ms: start.elapsed().as_millis(),
                affected_rows: None,
                message: None,
            }
        }
        SqlOperation::Write => {
            let affected = db
                .conn
                .execute(&sanitized_query, [])
                .map_err(|e| format!("Failed to execute write query: {}", e))?;

            SqlQueryResponse {
                operation: "write".to_string(),
                headers: Vec::new(),
                rows: Vec::new(),
                total_rows: 0,
                truncated: false,
                execution_time_ms: start.elapsed().as_millis(),
                affected_rows: Some(affected as usize),
                message: Some(format!(
                    "Query executed successfully. {} rows affected.",
                    affected
                )),
            }
        }
        SqlOperation::Ddl => {
            db.conn
                .execute(&sanitized_query, [])
                .map_err(|e| format!("Failed to execute schema query: {}", e))?;

            SqlQueryResponse {
                operation: "ddl".to_string(),
                headers: Vec::new(),
                rows: Vec::new(),
                total_rows: 0,
                truncated: false,
                execution_time_ms: start.elapsed().as_millis(),
                affected_rows: None,
                message: Some("Schema updated successfully.".into()),
            }
        }
        SqlOperation::Dangerous => {
            return Err("Dangerous operation detected. This operation is not allowed.".into());
        }
    };

    Ok(response)
}

#[tauri::command]
pub fn sql_export_query(
    state: tauri::State<AppState>,
    query: String,
    destination: String,
    options: Option<SqlExportOptions>,
) -> Result<SqlExportResponse, String> {
    let sanitized_query = sanitize_query(&query)?;
    let opts = options.unwrap_or_default();
    let operation = detect_sql_operation(&sanitized_query);
    ensure_operation_allowed(operation, opts.allow_write, opts.allow_ddl)?;

    if operation != SqlOperation::Read {
        return Err("Only read/SELECT queries can be exported.".into());
    }

    if has_sql_injection_risk(&sanitized_query) {
        return Err("Potential SQL injection detected. Please review your query.".into());
    }

    let format = opts.format.as_deref().unwrap_or("csv").to_ascii_lowercase();
    let delimiter = match format.as_str() {
        "csv" => b',',
        "tsv" => b'\t',
        other => {
            return Err(format!("Unsupported export format: {}", other));
        }
    };

    let path = Path::new(&destination);
    if let Some(parent) = path.parent() {
        create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directories: {}", e))?;
    }

    let db = state
        .biovault_db
        .lock()
        .map_err(|_| "Failed to lock database")?;
    let mut stmt = db
        .conn
        .prepare(&sanitized_query)
        .map_err(|e| format!("Failed to prepare export query: {}", e))?;
    let headers: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("Failed to execute export query: {}", e))?;

    let file = File::create(path).map_err(|e| format!("Failed to create export file: {}", e))?;
    let mut writer = csv::WriterBuilder::new()
        .delimiter(delimiter)
        .from_writer(file);

    writer
        .write_record(&headers)
        .map_err(|e| format!("Failed to write headers: {}", e))?;

    let mut rows_written = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Failed to read row: {}", e))?
    {
        let mut values = Vec::with_capacity(headers.len());
        for idx in 0..headers.len() {
            let val = row
                .get_ref(idx)
                .map_err(|e| format!("Failed to read column: {}", e))?;
            values.push(value_ref_to_string(val));
        }
        writer
            .write_record(&values)
            .map_err(|e| format!("Failed to write row: {}", e))?;
        rows_written += 1;
    }

    writer
        .flush()
        .map_err(|e| format!("Failed to flush export file: {}", e))?;

    Ok(SqlExportResponse {
        path: path.to_string_lossy().to_string(),
        rows_written,
    })
}

fn sanitize_query(query: &str) -> Result<String, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("Please provide a SQL query to run.".into());
    }

    let without_trailing_semicolon = trimmed.trim_end_matches(';').trim();
    Ok(without_trailing_semicolon.to_string())
}

fn ensure_operation_allowed(
    operation: SqlOperation,
    allow_write: bool,
    allow_ddl: bool,
) -> Result<(), String> {
    match operation {
        SqlOperation::Read => Ok(()),
        SqlOperation::Write => {
            if allow_write {
                Ok(())
            } else {
                Err("Write operations require explicit enablement.".into())
            }
        }
        SqlOperation::Ddl => {
            if allow_ddl {
                Ok(())
            } else {
                Err("Schema-changing operations are disabled for safety.".into())
            }
        }
        SqlOperation::Dangerous => {
            Err("Dangerous operation detected. This operation is not allowed.".into())
        }
    }
}

fn detect_sql_operation(query: &str) -> SqlOperation {
    let upper = query.trim_start().to_uppercase();

    if upper.contains("DROP DATABASE")
        || upper.contains("DROP SCHEMA")
        || upper.contains("ATTACH DATABASE")
        || upper.contains("DETACH DATABASE")
        || upper.contains("VACUUM INTO")
    {
        return SqlOperation::Dangerous;
    }

    if upper.starts_with("CREATE")
        || upper.starts_with("ALTER")
        || upper.starts_with("DROP")
        || upper.starts_with("TRUNCATE")
        || upper.starts_with("REINDEX")
    {
        return SqlOperation::Ddl;
    }

    if upper.starts_with("INSERT")
        || upper.starts_with("UPDATE")
        || upper.starts_with("DELETE")
        || upper.starts_with("REPLACE")
        || upper.starts_with("MERGE")
    {
        return SqlOperation::Write;
    }

    SqlOperation::Read
}

fn has_sql_injection_risk(query: &str) -> bool {
    let core = query.trim();
    if core.contains(';') {
        return true;
    }

    let upper = core.to_uppercase();
    let patterns = [
        "--",
        "/*",
        "*/",
        " UNION ",
        " OR 1=1",
        " OR '1'='1",
        " OR \"1\"=\"1\"",
    ];
    patterns.iter().any(|pattern| upper.contains(pattern))
}

fn execute_query(
    conn: &Connection,
    query: &str,
    max_rows: usize,
) -> Result<QueryResults, rusqlite::Error> {
    let mut stmt = conn.prepare(query)?;
    let headers = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();

    let mut rows = stmt.query([])?;
    let mut collected_rows = Vec::new();
    let mut total_rows = 0usize;
    let mut truncated = false;

    while let Some(row) = rows.next()? {
        total_rows += 1;

        if collected_rows.len() < max_rows {
            let mut values = Vec::with_capacity(headers.len());
            for idx in 0..headers.len() {
                values.push(value_ref_to_string(row.get_ref(idx)?));
            }
            collected_rows.push(values);
        } else {
            truncated = true;
        }
    }

    Ok(QueryResults {
        headers,
        rows: collected_rows,
        total_rows,
        truncated,
    })
}

fn value_ref_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "NULL".into(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(r) => {
            let mut s = r.to_string();
            if s.contains('.') {
                while s.ends_with('0') {
                    s.pop();
                }
                if s.ends_with('.') {
                    s.pop();
                }
            }
            s
        }
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Blob(bytes) => format!("[BLOB {} bytes]", bytes.len()),
    }
}

fn get_table_schema(conn: &Connection, table: &str) -> Result<SqlTableSchema, rusqlite::Error> {
    let mut columns = Vec::new();
    let pragma = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&pragma)?;

    let column_iter = stmt.query_map([], |row| {
        Ok(SqlColumnInfo {
            name: row.get(1)?,
            type_name: row.get(2)?,
            nullable: row.get::<_, i32>(3)? == 0,
            default_value: row.get(4)?,
            primary_key: row.get::<_, i32>(5)? == 1,
        })
    })?;

    for column in column_iter {
        columns.push(column?);
    }

    let mut indexes = Vec::new();
    let pragma = format!("PRAGMA index_list({table})");
    let mut stmt = conn.prepare(&pragma)?;
    let index_iter = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for index in index_iter {
        indexes.push(index?);
    }

    let mut foreign_keys = Vec::new();
    let pragma = format!("PRAGMA foreign_key_list({table})");
    let mut stmt = conn.prepare(&pragma)?;
    let fk_iter = stmt.query_map([], |row| {
        let table: String = row.get(2)?;
        let from: String = row.get(3)?;
        let to: String = row.get(4)?;
        Ok(format!("{from} -> {table}({to})"))
    })?;
    for fk in fk_iter {
        foreign_keys.push(fk?);
    }

    Ok(SqlTableSchema {
        columns,
        indexes,
        foreign_keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_operation_variants() {
        assert_eq!(
            detect_sql_operation("SELECT * FROM users"),
            SqlOperation::Read
        );
        assert_eq!(detect_sql_operation(" select count(*)"), SqlOperation::Read);
        assert_eq!(
            detect_sql_operation("INSERT INTO users VALUES (1)"),
            SqlOperation::Write
        );
        assert_eq!(
            detect_sql_operation("update users set name='a'"),
            SqlOperation::Write
        );
        assert_eq!(
            detect_sql_operation("DELETE FROM users"),
            SqlOperation::Write
        );
        assert_eq!(
            detect_sql_operation("CREATE TABLE test (id INT)"),
            SqlOperation::Ddl
        );
        assert_eq!(
            detect_sql_operation("ALTER TABLE test ADD COLUMN name TEXT"),
            SqlOperation::Ddl
        );
        assert_eq!(detect_sql_operation("DROP TABLE test"), SqlOperation::Ddl);
        assert_eq!(
            detect_sql_operation("DROP DATABASE foo"),
            SqlOperation::Dangerous
        );
        assert_eq!(
            detect_sql_operation("ATTACH DATABASE 'foo' AS bar"),
            SqlOperation::Dangerous
        );
    }

    #[test]
    fn detect_injection_patterns() {
        assert!(has_sql_injection_risk(
            "SELECT * FROM users; DROP TABLE users"
        ));
        assert!(has_sql_injection_risk("SELECT * FROM users -- comment"));
        assert!(has_sql_injection_risk("SELECT * FROM users /* comment */"));
        assert!(has_sql_injection_risk(
            "SELECT * FROM users UNION SELECT password FROM admin"
        ));
        assert!(has_sql_injection_risk(
            "SELECT * FROM users WHERE name = 'a' OR 1=1"
        ));
        assert!(!has_sql_injection_risk("SELECT * FROM users"));
        assert!(!has_sql_injection_risk("SELECT * FROM users WHERE id = 1"));
    }

    #[test]
    fn sanitize_query_trims_and_strips_semicolon() {
        assert_eq!(sanitize_query("SELECT 1; ").unwrap(), "SELECT 1");
        assert!(sanitize_query("   ").is_err());
    }

    #[test]
    fn value_conversion_handles_types() {
        assert_eq!(value_ref_to_string(ValueRef::Null), "NULL");
        assert_eq!(value_ref_to_string(ValueRef::Integer(42)), "42");
        assert_eq!(value_ref_to_string(ValueRef::Real(3.1400)), "3.14");
        assert_eq!(value_ref_to_string(ValueRef::Text(b"hello")), "hello");
        assert_eq!(
            value_ref_to_string(ValueRef::Blob(&[1_u8, 2, 3])),
            "[BLOB 3 bytes]"
        );
    }

    #[test]
    fn execute_query_limits_results() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE test (id INTEGER, name TEXT)", [])
            .unwrap();
        for i in 0..10 {
            conn.execute(
                "INSERT INTO test (id, name) VALUES (?1, ?2)",
                rusqlite::params![i, format!("name_{i}")],
            )
            .unwrap();
        }

        let results = execute_query(&conn, "SELECT * FROM test ORDER BY id", 5).unwrap();
        assert_eq!(results.headers, vec!["id", "name"]);
        assert_eq!(results.rows.len(), 5);
        assert!(results.truncated);
        assert_eq!(results.total_rows, 10);
    }

    #[test]
    fn get_schema_returns_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ref_id INTEGER, FOREIGN KEY(ref_id) REFERENCES demo(id))",
            [],
        )
        .unwrap();
        conn.execute("CREATE INDEX idx_demo_name ON demo(name)", [])
            .unwrap();
        let schema = get_table_schema(&conn, "demo").unwrap();
        assert_eq!(schema.columns.len(), 3);
        assert!(schema.indexes.contains(&"idx_demo_name".to_string()));
    }
}
