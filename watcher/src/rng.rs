//! rand 0.10 removed `rand::rngs::OsRng`; this is the drop-in used by every call that
//! needs a `CryptoRng`.
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
pub type OsRng = UnwrapErr<SysRng>;
#[allow(non_upper_case_globals)]
pub const OsRng: OsRng = UnwrapErr(SysRng);
