//! The Web Push wire protocol: message encryption and request authorization.
//!
//! Three RFCs meet here, and it is worth keeping which is which straight:
//!
//! - **RFC 8188** defines `aes128gcm`, a content encoding that carries its own
//!   salt and key id in a header block. It says how the body is framed.
//! - **RFC 8291** says how a push message derives that encoding's input keying
//!   material from an ECDH exchange with the subscription's public key and the
//!   shared auth secret.
//! - **RFC 8292** (VAPID) says how the sender identifies itself to the push
//!   service, with a signed JWT naming the service as its audience.
//!
//! This is implemented here rather than pulled from the `web-push` crate
//! because that crate reaches OpenSSL through `ece`, and this build has no
//! OpenSSL in it — see the note in Cargo.toml. The pieces it needs (P-256,
//! HKDF-SHA256, AES-128-GCM) were already in the dependency tree.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes128Gcm, Key, Nonce,
};
use base64::Engine;
use hkdf::Hkdf;
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::sec1::ToEncodedPoint,
    PublicKey, SecretKey,
};
use sha2::Sha256;

/// Record size written into the header. One record carries the whole message,
/// so this only has to exceed the ciphertext; 4096 is the conventional value.
const RECORD_SIZE: u32 = 4096;

/// A P-256 point in uncompressed SEC1 form: `0x04 || x || y`.
const PUBLIC_KEY_LEN: usize = 65;

/// The VAPID token's lifetime. RFC 8292 caps it at 24 hours; half that leaves
/// room for clock skew in either direction.
const VAPID_TOKEN_LIFETIME_SECS: u64 = 12 * 60 * 60;

pub(crate) fn b64url_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode base64url, tolerating the padding some browsers include.
pub(crate) fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let trimmed = s.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .ok()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WebPushError {
    /// The subscription's `p256dh` or `auth` was not usable.
    BadSubscription,
    /// The server's own VAPID key was not usable.
    BadSigningKey,
    /// The endpoint was not a URL with a host.
    BadEndpoint,
    Encryption,
}

// ─── RFC 8291 + RFC 8188: message encryption ─────────────────────────────────

/// Encrypt a payload for one subscription, producing a complete `aes128gcm`
/// body ready to be POSTed to the endpoint.
///
/// `ua_public` is the subscription's `p256dh` key and `auth_secret` its `auth`
/// value, both as the browser reported them.
pub(crate) fn encrypt(
    payload: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
) -> Result<Vec<u8>, WebPushError> {
    let mut salt = [0u8; 16];
    {
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut salt);
    }
    let ephemeral = SecretKey::random(&mut rand::rngs::OsRng);
    encrypt_with(payload, ua_public, auth_secret, &salt, &ephemeral)
}

/// The deterministic half of [`encrypt`], with the salt and ephemeral key
/// supplied. Split out so the RFC's test vector can be reproduced exactly.
fn encrypt_with(
    payload: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    salt: &[u8; 16],
    as_secret: &SecretKey,
) -> Result<Vec<u8>, WebPushError> {
    let ua_key =
        PublicKey::from_sec1_bytes(ua_public).map_err(|_| WebPushError::BadSubscription)?;
    let as_public_point = as_secret.public_key().to_encoded_point(false);
    let as_public = as_public_point.as_bytes();
    if as_public.len() != PUBLIC_KEY_LEN {
        return Err(WebPushError::Encryption);
    }

    // RFC 8291 §3.1: the ECDH shared secret is the x-coordinate alone.
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_key.as_affine());

    // RFC 8291 §3.4. The auth secret is the salt of this first derivation, and
    // the info binds the result to both parties' public keys — which is what
    // stops a key from one subscription being usable against another.
    let mut key_info = Vec::with_capacity(14 + PUBLIC_KEY_LEN * 2);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| WebPushError::Encryption)?;

    // RFC 8188 §2.2: the content encoding's own derivation, salted with the
    // random salt that travels in the header.
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| WebPushError::Encryption)?;
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| WebPushError::Encryption)?;

    // RFC 8188 §2: every record ends with a delimiter saying whether it is the
    // last. There is only ever one record here, so it always is (0x02).
    let mut record = Vec::with_capacity(payload.len() + 1);
    record.extend_from_slice(payload);
    record.push(0x02);

    let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &record,
                aad: b"",
            },
        )
        .map_err(|_| WebPushError::Encryption)?;

    // RFC 8188 §2.1 header: salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(idlen)
    let mut body = Vec::with_capacity(21 + PUBLIC_KEY_LEN + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(PUBLIC_KEY_LEN as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

// ─── RFC 8292: VAPID ─────────────────────────────────────────────────────────

/// Build the `Authorization` header value proving this server sent the message.
///
/// `private_key` is the raw 32-byte P-256 scalar, base64url-encoded — the form
/// every VAPID tool emits. `subject` is a `mailto:` or `https:` URL the push
/// service can use to contact whoever runs this server.
pub(crate) fn vapid_authorization(
    endpoint: &str,
    private_key: &str,
    subject: &str,
    now_secs: u64,
) -> Result<String, WebPushError> {
    let audience = endpoint_audience(endpoint)?;
    let scalar = b64url_decode(private_key).ok_or(WebPushError::BadSigningKey)?;
    let signing_key = SigningKey::from_slice(&scalar).map_err(|_| WebPushError::BadSigningKey)?;

    let header = b64url_encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::json!({
        "aud": audience,
        "exp": now_secs + VAPID_TOKEN_LIFETIME_SECS,
        "sub": subject,
    });
    let payload = b64url_encode(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{payload}");

    // ES256 signatures are the fixed-width r‖s pair, not the DER encoding.
    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let token = format!("{signing_input}.{}", b64url_encode(&signature.to_bytes()));

    let public_key = b64url_encode(
        signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    Ok(format!("vapid t={token}, k={public_key}"))
}

/// The `aud` claim: the push service's origin, scheme and host only.
fn endpoint_audience(endpoint: &str) -> Result<String, WebPushError> {
    let (scheme, rest) = endpoint
        .split_once("://")
        .ok_or(WebPushError::BadEndpoint)?;
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(WebPushError::BadEndpoint);
    }
    Ok(format!("{scheme}://{host}"))
}

/// The public half of a raw base64url P-256 private key, in the uncompressed
/// form a browser expects as `applicationServerKey`.
pub(crate) fn public_key_from_private(private_key: &str) -> Option<String> {
    let scalar = b64url_decode(private_key)?;
    let secret = SecretKey::from_slice(&scalar).ok()?;
    Some(b64url_encode(
        secret.public_key().to_encoded_point(false).as_bytes(),
    ))
}

/// Mint a fresh application-server key, returned as a base64url raw scalar.
///
/// A P-256 private key is a scalar in a specific range, so it is generated
/// rather than taken as 32 random bytes.
pub(crate) fn generate_private_key() -> String {
    b64url_encode(&SecretKey::random(&mut rand::rngs::OsRng).to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8291 §5, reproduced exactly. Every input is fixed, so a wrong info
    /// string, a wrong derivation order or a wrong header layout all show up
    /// here as a mismatched body rather than as a push that silently fails to
    /// decrypt on someone's phone.
    #[test]
    fn rfc8291_example_message() {
        let plaintext = b"When I grow up, I want to be a watermelon";
        let auth_secret = b64url_decode("BTBZMqHH6r4Tts7J_aSIgg").unwrap();
        let ua_public = b64url_decode(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        )
        .unwrap();
        let as_private = b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw").unwrap();
        let salt_bytes = b64url_decode("DGv6ra1nlYgDCS1FRnbzlw").unwrap();
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&salt_bytes);

        let as_secret = SecretKey::from_slice(&as_private).unwrap();
        let body = encrypt_with(plaintext, &ua_public, &auth_secret, &salt, &as_secret).unwrap();

        let expected = b64url_decode(concat!(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        ))
        .unwrap();
        assert_eq!(body, expected);
    }

    /// The header the receiver parses before it can derive anything.
    #[test]
    fn body_carries_the_salt_record_size_and_sender_key() {
        let ua = SecretKey::random(&mut rand::rngs::OsRng);
        let ua_public = ua.public_key().to_encoded_point(false);
        let body = encrypt(b"hello", ua_public.as_bytes(), &[7u8; 16]).unwrap();

        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        assert_eq!(body[20], 65);
        // The key id is a valid point, and the ciphertext carries GCM's tag on
        // top of the plaintext and its record delimiter.
        assert!(PublicKey::from_sec1_bytes(&body[21..86]).is_ok());
        assert_eq!(body.len(), 86 + "hello".len() + 1 + 16);
    }

    #[test]
    fn a_bad_subscription_key_is_rejected_not_encrypted_to() {
        let err = encrypt(b"hi", b"not a point", &[0u8; 16]).unwrap_err();
        assert_eq!(err, WebPushError::BadSubscription);
    }

    #[test]
    fn audience_is_the_endpoint_origin() {
        assert_eq!(
            endpoint_audience("https://fcm.googleapis.com/fcm/send/abc123").unwrap(),
            "https://fcm.googleapis.com"
        );
        assert_eq!(
            endpoint_audience("https://updates.push.services.mozilla.com/wpush/v2/xyz").unwrap(),
            "https://updates.push.services.mozilla.com"
        );
        assert_eq!(
            endpoint_audience("not-a-url").unwrap_err(),
            WebPushError::BadEndpoint
        );
    }

    #[test]
    fn authorization_is_a_signed_jwt_naming_the_endpoint() {
        let private_key = generate_private_key();
        let header = vapid_authorization(
            "https://push.example/x",
            &private_key,
            "mailto:a@example.com",
            1_700_000_000,
        )
        .unwrap();

        let token = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);

        let claims: serde_json::Value =
            serde_json::from_slice(&b64url_decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://push.example");
        assert_eq!(claims["sub"], "mailto:a@example.com");
        assert_eq!(claims["exp"], 1_700_000_000u64 + VAPID_TOKEN_LIFETIME_SECS);

        // ES256's signature is the fixed 64-byte r‖s pair.
        assert_eq!(b64url_decode(parts[2]).unwrap().len(), 64);

        // The advertised key must be the one that signed, or the push service
        // rejects the token.
        let advertised = header.split(", k=").nth(1).unwrap();
        assert_eq!(advertised, public_key_from_private(&private_key).unwrap());
    }

    #[test]
    fn generated_keys_round_trip_to_a_public_point() {
        let private_key = generate_private_key();
        let public = public_key_from_private(&private_key).unwrap();
        let bytes = b64url_decode(&public).unwrap();
        assert_eq!(bytes.len(), PUBLIC_KEY_LEN);
        assert_eq!(bytes[0], 0x04);
    }

    #[test]
    fn padded_base64_from_a_browser_still_decodes() {
        // Chrome reports keys unpadded, but not every client does.
        assert_eq!(b64url_decode("YWJj"), b64url_decode("YWJj="));
    }
}
