# Sophos reservation sync

The dashboard reads DHCP reservations from `192.168.1.1:4444` using the
`iptracker_sync` account. No Sophos configuration writes are implemented.

The dashboard's **Sophos reservations** panel provides **Sync Now**, the last
successful sync, errors, and a checkbox for automatic sync every hour.
The schedule runs inside the Node server: leave the computer awake and server
running. Run Node under the same Windows account that ran `setup-sophos.ps1`.

Credentials are Windows DPAPI-encrypted in
`%LOCALAPPDATA%\IPTracker\Sophos\192.168.1.1-4444.credential.xml`, outside the
project and website. To replace the password, run `scripts/setup-sophos.ps1`.

The legacy TLS exception is restricted to one endpoint and one pinned certificate.
The connector validates the pinned SHA-256 fingerprint, supplied CA signature and
certificate validity before releasing the TLS socket to the HTTP client. It does
not follow redirects. A changed certificate stops syncing. The appliance's weak
1024-bit key remains a limitation; plan a modern certificate when practical.

Imported reservations have source `sophos`, assignment status `reserved`, and are
displayed as **Assigned in Sophos**. Hostname, MAC, DHCP server, interface, and sync
timestamp are stored. The **Sophos** filter within a VLAN shows these records.
These assignments do not imply that a device is online. Ping history is separate.

Manual entries win on IP conflicts, which appear in the sync panel. Previously
imported reservations missing from Sophos are retained and flagged for review,
not automatically released. Edit reservations in Sophos; local API editing and
deletion of Sophos-owned entries are blocked. Empty or invalid responses retain
the previous inventory. Dynamic DHCP pools and active leases are not imported.

`data/entries-before-sophos.json` preserves assignments before the first import.
`data/sophos-sync-state.json` stores schedule and last-sync state.
`data/sophos-preview.json` stores the most recent reservation-only preview.
None of these files is served by the static web directory.

Validation: `npm run build`, `node scripts/test-sophos-merge.js`.
