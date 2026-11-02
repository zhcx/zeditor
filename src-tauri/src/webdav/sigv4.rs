//! AWS Signature Version 4 request signing, generalized from the image
//! hosting S3 uploader so the backup client can sign GET/PUT/DELETE/HEAD.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// SHA-256 of an empty payload, used for GET/DELETE/HEAD requests.
pub const EMPTY_PAYLOAD_HASH: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Credentials and request context needed to sign one S3 request.
pub struct SigningContext<'a> {
    pub method: &'a str,
    /// Path+query portion of the request URI (e.g. `/bucket/key`).
    pub uri: &'a str,
    /// Canonical headers block (`host:...\nx-amz-date:...\n...`).
    pub canonical_headers: &'a str,
    pub signed_headers: &'a str,
    pub payload_hash: &'a str,
    pub access_key: &'a str,
    pub secret_key: &'a str,
    pub region: &'a str,
    /// `YYYYMMDDTHHMMSSZ` timestamp.
    pub timestamp: &'a str,
    /// `YYYYMMDD` date.
    pub date: &'a str,
}

/// Build the `Authorization` header value for a SigV4-signed S3 request.
///
/// The canonical headers must already contain the `x-amz-date` and
/// `x-amz-content-sha256` values referenced by `signed_headers`.
pub fn authorization(context: &SigningContext<'_>) -> String {
    let canonical_request = format!(
        "{}\n{}\n\n{}\n{}\n{}",
        context.method,
        context.uri,
        context.canonical_headers,
        context.signed_headers,
        context.payload_hash
    );
    let string_to_sign = string_to_sign(
        context.timestamp,
        context.date,
        context.region,
        &canonical_request,
    );
    let signature = calculate_signature(
        context.secret_key,
        context.date,
        context.region,
        &string_to_sign,
    );
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}/{}/s3/aws4_request, SignedHeaders={}, Signature={}",
        context.access_key, context.date, context.region, context.signed_headers, signature
    )
}

fn string_to_sign(timestamp: &str, date: &str, region: &str, canonical_request: &str) -> String {
    let credential_scope = format!("{date}/{region}/s3/aws4_request");
    let request_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    format!("AWS4-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{request_hash}")
}

fn calculate_signature(secret_key: &str, date: &str, region: &str, string_to_sign: &str) -> String {
    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC creation failed");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// SHA-256 hex digest of a payload; empty bytes yield `EMPTY_PAYLOAD_HASH`.
pub fn payload_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNED_HEADERS: &str = "host;x-amz-content-sha256;x-amz-date";

    #[test]
    fn empty_payload_hash_is_the_sha256_of_empty_bytes() {
        assert_eq!(payload_hash(b""), EMPTY_PAYLOAD_HASH);
        assert_eq!(payload_hash(b""), hex::encode(Sha256::digest(b"")));
    }

    fn context<'a>(
        region: &'a str,
        secret: &'a str,
        method: &'a str,
        uri: &'a str,
    ) -> SigningContext<'a> {
        SigningContext {
            method,
            uri,
            canonical_headers:
                "host:example.com\nx-amz-content-sha256:abc\0x-amz-date:20260821T000000Z\n",
            signed_headers: SIGNED_HEADERS,
            payload_hash: "abc",
            access_key: "AKID",
            secret_key: secret,
            region,
            timestamp: "20260821T000000Z",
            date: "20260821",
        }
    }

    #[test]
    fn authorization_is_deterministic_for_fixed_inputs() {
        let first = authorization(&context("us-east-1", "secret", "PUT", "/bucket/note.md"));
        let second = authorization(&context("us-east-1", "secret", "PUT", "/bucket/note.md"));
        assert_eq!(first, second);
        assert!(first
            .starts_with("AWS4-HMAC-SHA256 Credential=AKID/20260821/us-east-1/s3/aws4_request"));
        assert!(first.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
    }

    #[test]
    fn signature_changes_with_region_and_secret() {
        assert_ne!(
            authorization(&context("us-east-1", "secret-a", "GET", "/bucket/key")),
            authorization(&context("cn-hangzhou", "secret-a", "GET", "/bucket/key"))
        );
        assert_ne!(
            authorization(&context("us-east-1", "secret-a", "GET", "/bucket/key")),
            authorization(&context("us-east-1", "secret-b", "GET", "/bucket/key"))
        );
    }
}
