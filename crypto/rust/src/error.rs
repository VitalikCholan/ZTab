//! Errors cross the WASM boundary as the string `"<code>: <message>"`; the TypeScript layer
//! turns the code back into a `CryptoError`. Codes are the ones the PWA distinguishes
//! (spec §4); everything a correct caller can never trigger is `internal`.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidRecipient,
    InvalidPczt,
    PcztMismatch,
    SignFailed,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidRecipient => "invalid_recipient",
            Code::InvalidPczt => "invalid_pczt",
            Code::PcztMismatch => "pczt_mismatch",
            Code::SignFailed => "sign_failed",
            Code::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoError {
    pub code: Code,
    pub message: String,
}

impl CryptoError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Code::Internal, message)
    }
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for CryptoError {}
