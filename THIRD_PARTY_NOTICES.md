# Third-party interoperability notice

The optional **Cricfy Kodi** source connector is based on the discovery and playlist formats documented in:

- https://github.com/itsyourap/cricfy-kodi-plugin
- Upstream repository licence: GPL-3.0-or-later (see upstream `LICENSE`).

The connector's configuration is **not bundled** with Multicast Studio. When explicitly requested by an administrator, Multicast Studio downloads the **official published build artifact**, extracts only the add-on's configuration resources, and stores them in `data/cricfy-addon-config.json` (file mode 0600). Alternatively, an administrator may supply an official built add-on ZIP.

The GitHub **source ZIP** does not contain the generated release resources required for discovery.

The connector uses the add-on's published directory and playlist protocols. Cryptographic wrapping used for **catalog formatting** is distinct from media DRM: this connector does **not** implement media decryption or DRM license acquisition, and it discards channel entries declaring adaptive license keys.

Multicast Studio does not host or provide third-party broadcasts. The administrator is responsible for using streams they are authorized to access and redistribute. The upstream project and any channel owners have not endorsed this integration. Third-party APIs and playlists may change or become unavailable at any time.

If redistributing a software version incorporating code derived from GPL-covered implementations, review the resulting licensing obligations before doing so.
