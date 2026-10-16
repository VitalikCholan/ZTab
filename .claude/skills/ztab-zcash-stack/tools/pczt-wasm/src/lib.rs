//! Throwaway probe: parse a proved PCZT and sign its Ironwood spends inside wasm32.
use core::convert::Infallible;
use orchard::keys::{SpendAuthorizingKey, SpendingKey};
use pczt::roles::{signer::Signer, verifier::Verifier};
use rand::{SeedableRng, rngs::StdRng};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// Parse and construct a Signer. 1 = ok.
#[no_mangle]
pub extern "C" fn probe_parse(ptr: *const u8, len: usize) -> i32 {
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
    match pczt::Pczt::parse(bytes) {
        Ok(p) => Signer::new(p).is_ok() as i32,
        Err(_) => 0,
    }
}

/// Sign every Ironwood spend the given Orchard spending key (32 bytes) can
/// authorize, using a caller-seeded RNG (32 bytes). PCZTs from view-only
/// accounts carry no ZIP 32 derivation, so we try every action and skip the
/// ones that answer `WrongSpendAuthorizingKey` (dummy spends, other keys).
/// Writes the serialized signed PCZT to a fresh buffer; returns its pointer and
/// stores the length in `out_len`. Returns null on failure (error code in out_len).
#[no_mangle]
pub extern "C" fn probe_sign(
    pczt_ptr: *const u8,
    pczt_len: usize,
    sk_ptr: *const u8,
    seed_ptr: *const u8,
    out_len: *mut usize,
) -> *mut u8 {
    let fail = |code: usize| -> *mut u8 {
        unsafe { *out_len = code };
        core::ptr::null_mut()
    };
    let bytes = unsafe { core::slice::from_raw_parts(pczt_ptr, pczt_len) };
    let sk_bytes: [u8; 32] = unsafe { core::slice::from_raw_parts(sk_ptr, 32) }.try_into().unwrap();
    let seed: [u8; 32] = unsafe { core::slice::from_raw_parts(seed_ptr, 32) }.try_into().unwrap();

    let Ok(pczt) = pczt::Pczt::parse(bytes) else { return fail(1) };
    let action_count = {
        let mut n = 0usize;
        let _ = Verifier::new(pczt.clone()).with_ironwood::<Infallible, _>(|bundle| {
            n = bundle.actions().len();
            Ok(())
        });
        n
    };
    let sk = match Option::<SpendingKey>::from(SpendingKey::from_bytes(sk_bytes)) {
        Some(sk) => sk,
        None => return fail(3),
    };
    let ask = SpendAuthorizingKey::from(&sk);
    let mut rng = StdRng::from_seed(seed);
    let Ok(mut signer) = Signer::new(pczt) else { return fail(4) };
    let mut signed = 0usize;
    for i in 0..action_count {
        match signer.sign_ironwood(&mut rng, i, &ask) {
            Ok(()) => signed += 1,
            // Not our spend (dummy, or another key): skip. Anything else is a real failure.
            Err(pczt::roles::signer::Error::IronwoodSign(
                orchard::pczt::SignerError::WrongSpendAuthorizingKey,
            )) => {}
            Err(_) => return fail(100 + i),
        }
    }
    if signed == 0 {
        return fail(6);
    }
    let Ok(out) = signer.finish().serialize() else { return fail(5) };
    let mut out = out.into_boxed_slice();
    unsafe { *out_len = out.len() };
    let p = out.as_mut_ptr();
    core::mem::forget(out);
    p
}
