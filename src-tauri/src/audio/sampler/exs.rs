//! Reads a Logic EXS instrument file into zones. Filled in by the EXS ticket.

use std::path::Path;

use super::Zone;

/// One sample file the EXS names, and how many frames of it the zones may use.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleRef {
    pub path: std::path::PathBuf,
    pub frames: usize,
}

/// The zones and the sample files an EXS file describes. `Zone::sample` indexes `samples`.
#[derive(Debug)]
pub struct Exs {
    pub zones: Vec<Zone>,
    pub samples: Vec<SampleRef>,
}

pub fn read(_path: &Path) -> Result<Exs, String> {
    todo!("exs ticket")
}
