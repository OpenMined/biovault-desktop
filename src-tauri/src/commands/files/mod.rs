use serde::{Deserialize, Serialize};

// Shared types used across multiple file modules
#[derive(Serialize, Deserialize, Debug)]
pub struct FileMetadata {
    pub participant_id: Option<String>,
    pub data_type: Option<String>,
    pub source: Option<String>,
    pub grch_version: Option<String>,
    #[serde(default)]
    pub reference_path: Option<String>,
    #[serde(default)]
    pub reference_index_path: Option<String>,
    pub row_count: Option<i64>,
    pub chromosome_count: Option<i64>,
    pub inferred_sex: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct GenotypeMetadata {
    pub data_type: String,
    pub source: Option<String>,
    pub grch_version: Option<String>,
    pub row_count: Option<i64>,
    pub chromosome_count: Option<i64>,
    pub inferred_sex: Option<String>,
}

// Sub-modules
pub mod analyze;
pub mod crud;
pub mod import;
pub mod queue;
pub mod reference_data;
pub mod sample_data;
pub mod scan;

// Re-export all commands for convenience
pub use analyze::*;
pub use crud::*;
pub use import::*;
pub use queue::*;
pub use reference_data::*;
pub use sample_data::*;
pub use scan::*;
