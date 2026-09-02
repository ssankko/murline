//! The one shape every command answers with when it cannot do what it was asked: a kind the window
//! may act on, and a sentence the window only ever shows.

use serde::Serialize;

/// What happened, as far as the window may act on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// The file the command was asked about is no longer there.
    Gone,
    /// A rule of the app or the sound engine said no, and the text is its reason.
    Refused,
    /// Anything else, with what the OS or a library reported as the text.
    Failed,
}

/// The window switches on the kind and shows the text; it never reads the text to decide anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct Refusal {
    pub kind: Kind,
    pub text: String,
}

impl Refusal {
    /// For a command that finds the file gone itself, rather than hearing it from the file system.
    pub fn gone(text: impl Into<String>) -> Self {
        Refusal { kind: Kind::Gone, text: text.into() }
    }

    pub fn failed(text: impl Into<String>) -> Self {
        Refusal { kind: Kind::Failed, text: text.into() }
    }
}

/// A file that is not there is the one thing the window acts on; every other io failure is one it
/// can only report.
impl From<std::io::Error> for Refusal {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Refusal::gone(error.to_string()),
            _ => Refusal::failed(error.to_string()),
        }
    }
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Refusal::failed(error.to_string())
    }
}

/// The trash crate answers every failure as one text of its own, a file that is not there among
/// them, so nothing it says can be read as `gone`.
impl From<trash::Error> for Refusal {
    fn from(error: trash::Error) -> Self {
        Refusal::failed(error.to_string())
    }
}

/// Every string the modules build inside is a reason a rule or the sound engine gave.
impl From<String> for Refusal {
    fn from(text: String) -> Self {
        Refusal { kind: Kind::Refused, text }
    }
}

impl From<&str> for Refusal {
    fn from(text: &str) -> Self {
        Refusal::from(text.to_string())
    }
}
