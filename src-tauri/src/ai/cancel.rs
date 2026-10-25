//! Per-request cancellation for streaming chat responses.
//!
//! The webview may stop listening at any moment, but the HTTP stream keeps
//! producing tokens until the backend is told to stop. Each request registers a
//! watch channel; the `cancel_ai_chat` command flips it and the streaming loop
//! observes it through `tokio::select!`.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

use tokio::sync::watch;

type Registry = Mutex<HashMap<String, (u64, watch::Sender<bool>)>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_token() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Removes the registry entry when the request finishes for any reason.
pub struct CancellationGuard {
    request_id: String,
    token: u64,
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        let mut guard = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A duplicate request id may have replaced this entry; never remove a
        // newer stream's sender just because the older one finished.
        if guard
            .get(&self.request_id)
            .is_some_and(|(token, _)| *token == self.token)
        {
            guard.remove(&self.request_id);
        }
    }
}

/// Register a cancellable request. Reusing an id replaces the previous sender;
/// its receiver observes a closed channel and stops as well.
pub fn register(request_id: &str) -> (watch::Receiver<bool>, CancellationGuard) {
    let (sender, receiver) = watch::channel(false);
    let token = next_token();
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(request_id.to_string(), (token, sender));
    (
        receiver,
        CancellationGuard {
            request_id: request_id.to_string(),
            token,
        },
    )
}

/// Signal a running request to stop. Returns false when it already finished.
pub fn cancel(request_id: &str) -> bool {
    let guard = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(request_id) {
        Some((_, sender)) => sender.send(true).is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_wakes_the_registered_receiver_and_guard_cleans_up() {
        let (mut receiver, guard) = register("request-1");
        assert!(!*receiver.borrow());
        assert!(cancel("request-1"));
        assert!(receiver.has_changed().expect("sender is registered"));
        assert!(*receiver.borrow_and_update());

        drop(guard);
        assert!(!cancel("request-1"));
    }

    #[test]
    fn cancelling_an_unknown_request_is_a_no_op() {
        assert!(!cancel("missing-request"));
    }

    #[test]
    fn a_finished_guard_never_removes_a_newer_registration_with_the_same_id() {
        let (_first_receiver, first_guard) = register("duplicate-id");
        let (mut second_receiver, second_guard) = register("duplicate-id");
        drop(first_guard);

        assert!(
            cancel("duplicate-id"),
            "the newer registration must stay cancellable"
        );
        assert!(*second_receiver.borrow_and_update());
        drop(second_guard);
        assert!(!cancel("duplicate-id"));
    }
}
