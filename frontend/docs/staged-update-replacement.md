# Staged update replacement

AO records updater provenance in `~/.ao/staged-update-journal.json`. The journal preserves the candidate that native Squirrel may have staged while a newer candidate is checked, downloaded, verified, and handed off. A replacement owns the journal only after electron-updater confirms its completed handoff.

The journal does not control Squirrel. Deleting or changing AO's record cannot revoke a native install request. Until the native boundary is addressed separately, quitting outside AO during a replacement may still install the older candidate. The renderer must keep that warning visible, and AO's Restart and Install action must remain disabled until the replacement becomes the staged candidate.

Writes use a same-directory temporary file, file synchronization, rename, and directory synchronization. Writes are serialized. Invalid or unknown journal records are quarantined and logged instead of being interpreted as safe.


Integration with current main preserves #4849's restaging suppression, escalation clock, release notes and restart confirmation. The old `staged-update.json` record migrates into the journal; there is no parallel legacy writer and channel switches never discard A. A replacement download remains in the serialized operation even when automatic downloading is disabled. The verified download event precedes macOS handoff, so replacement promotion waits for the operation's download promise to finish. This confirms updater handoff, not atomic native replacement or cancellation.

#4922's quit-time protection remains enabled on Windows and Linux while replacement is incomplete. On macOS the install-on-quit flag must remain enabled for the updater to hand the replacement to Squirrel; AO's own install entry point is guarded separately. Native cancellation and stronger native operation identity remain PR3 work. #4929 changes upstream PR-claim authorization and does not change the updater.
