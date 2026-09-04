# Staged update replacement

AO records updater provenance in `~/.ao/staged-update-journal.json`. The journal preserves the candidate that native Squirrel may have staged while a newer candidate is checked, downloaded, verified, and handed off. A replacement owns the journal only after electron-updater confirms its completed handoff.

The journal does not control Squirrel. Deleting or changing AO's record cannot revoke a native install request. Until the native boundary is addressed separately, quitting outside AO during a replacement may still install the older candidate. The renderer must keep that warning visible, and AO's Restart and Install action must remain disabled until the replacement becomes the staged candidate.

Writes use a same-directory temporary file, file synchronization, rename, and directory synchronization. Writes are serialized. Invalid or unknown journal records are quarantined and logged instead of being interpreted as safe.
